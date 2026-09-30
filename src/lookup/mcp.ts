import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ToolContext } from "../orchestrator/tools.js";
import { errorMessage, parseArgs, truncate, type ToolSet } from "../orchestrator/toolset.js";

const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_DESCRIPTION = 600;

const ServerSchema = z
  .object({
    /** Start a local server speaking MCP on stdio. */
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    /** Or connect to a remote server over streamable HTTP. */
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    /** Tool names to offer the voice model, or "*" for all of them. */
    tools: z.union([z.literal("*"), z.array(z.string())]),
    enabled: z.boolean().default(true),
  })
  .refine((s) => !!s.command !== !!s.url, { message: "give either command or url" });

const ConfigSchema = z.object({ servers: z.record(z.string(), ServerSchema).nullish() });

export type McpServerConfig = z.infer<typeof ServerSchema>;

/** Replace ${VAR} with environment variables, so secrets stay in .env. */
function interpolate(value: string, missing: Set<string>): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const found = process.env[name];
    if (found === undefined || found === "") missing.add(name);
    return found ?? "";
  });
}

function interpolateAll(record: Record<string, string>, missing: Set<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, interpolate(v, missing)]));
}

interface Route {
  server: Server;
  tool: string;
}

interface Server {
  name: string;
  config: McpServerConfig;
  client?: Client;
  connecting?: Promise<Client>;
}

/**
 * Tools from MCP servers listed in config/mcp.yaml, offered straight to the voice
 * model as "<server>__<tool>". Servers connect in the background at startup; their
 * tools appear once connected. Only allowlisted tools are offered, since small
 * models pick worse from long lists and these run without an agent's permission prompts.
 */
export class McpTools implements ToolSet {
  private readonly servers: Server[];
  private defs: ChatCompletionTool[] = [];
  private readonly routes = new Map<string, Route>();

  constructor(
    servers: Record<string, McpServerConfig>,
    private readonly log: (...a: unknown[]) => void,
    private readonly maxResultChars = 4000,
    /** Test hook: build the transport for a server instead of spawning or dialing it. */
    private readonly makeTransport?: (name: string, config: McpServerConfig) => Transport,
  ) {
    this.servers = Object.entries(servers)
      .filter(([, config]) => config.enabled)
      .map(([name, config]) => ({ name, config }));
  }

  /** Read the servers from a YAML file; a missing file means no MCP servers. */
  static fromFile(path: string, log: (...a: unknown[]) => void): McpTools {
    if (!existsSync(path)) return new McpTools({}, log);
    const parsed = ConfigSchema.safeParse(parseYaml(readFileSync(path, "utf8")) ?? {});
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Invalid ${path}: ${problems}`);
    }
    return new McpTools(parsed.data.servers ?? {}, log);
  }

  get definitions(): ChatCompletionTool[] {
    return this.defs;
  }

  handles(name: string): boolean {
    return this.routes.has(name);
  }

  /** Connect every server (in parallel) and collect their tools. Failures are logged, not thrown. */
  async connect(): Promise<void> {
    await Promise.all(
      this.servers.map(async (server) => {
        try {
          const client = await this.client(server);
          await this.addTools(server, client);
        } catch (err) {
          this.log(`mcp ${server.name}: ${errorMessage(err)}`);
        }
      }),
    );
  }

  async execute(name: string, rawArgs: string, ctx: ToolContext): Promise<unknown> {
    const route = this.routes.get(name);
    if (!route) return { error: `unknown tool ${name}` };
    const args = parseArgs(rawArgs);
    if (typeof args === "string") return { error: args };
    const call = async () => {
      const client = await this.client(route.server);
      return client.callTool({ name: route.tool, arguments: args }, undefined, { signal: ctx.signal, timeout: CALL_TIMEOUT_MS });
    };
    let result: Awaited<ReturnType<typeof call>>;
    try {
      result = await call();
    } catch (err) {
      if (ctx.signal?.aborted) return { error: errorMessage(err) };
      // Remote sessions expire and local servers crash: reconnect once and retry.
      this.log(`mcp ${route.server.name}: ${errorMessage(err)}; reconnecting`);
      await this.disconnect(route.server);
      try {
        result = await call();
      } catch (retryErr) {
        return { error: errorMessage(retryErr) };
      }
    }
    const content = (result.content ?? []) as { type: string; text?: string }[];
    let text = content.map((part) => (part.type === "text" ? part.text : `[${part.type} omitted]`)).join("\n");
    if (!text.trim() && result.structuredContent) text = JSON.stringify(result.structuredContent);
    text = truncate(text, this.maxResultChars);
    return result.isError ? { error: text || "the tool reported an error" } : { result: text };
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((s) => this.disconnect(s)));
  }

  private client(server: Server): Promise<Client> {
    if (server.client) return Promise.resolve(server.client);
    server.connecting ??= this.open(server).then(
      (client) => {
        server.client = client;
        server.connecting = undefined;
        return client;
      },
      (err) => {
        server.connecting = undefined;
        throw err;
      },
    );
    return server.connecting;
  }

  private async open(server: Server): Promise<Client> {
    const { config } = server;
    const missing = new Set<string>();
    let stderr = "";
    let transport: Transport;
    if (this.makeTransport) {
      transport = this.makeTransport(server.name, config);
    } else if (config.url) {
      const url = interpolate(config.url, missing);
      const headers = interpolateAll(config.headers, missing);
      transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
    } else {
      const stdio = new StdioClientTransport({
        command: interpolate(config.command!, missing),
        args: config.args.map((a) => interpolate(a, missing)),
        env: interpolateAll(config.env, missing),
        cwd: config.cwd,
        stderr: "pipe",
      });
      // Keep the tail of the server's stderr to explain a failed start.
      stdio.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-500)));
      transport = stdio;
    }
    if (missing.size) throw new Error(`needs ${[...missing].join(", ")} in .env`);
    const client = new Client({ name: "voice-agent", version: "0.1.0" });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timed out connecting")), CONNECT_TIMEOUT_MS))),
      ]);
    } catch (err) {
      await client.close().catch(() => {});
      const detail = stderr.trim() ? ` (${stderr.trim().split("\n").pop()})` : "";
      throw new Error(`${errorMessage(err)}${detail}`);
    } finally {
      clearTimeout(timer);
    }
    return client;
  }

  private async disconnect(server: Server): Promise<void> {
    const client = server.client ?? (await server.connecting?.catch(() => undefined));
    server.client = undefined;
    server.connecting = undefined;
    await client?.close().catch(() => {});
  }

  private async addTools(server: Server, client: Client): Promise<void> {
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);

    const allowed = server.config.tools;
    const offered = allowed === "*" ? tools : tools.filter((t) => allowed.includes(t.name));
    if (allowed !== "*") {
      const unknown = allowed.filter((name) => !tools.some((t) => t.name === name));
      if (unknown.length) this.log(`mcp ${server.name}: no tool(s) ${unknown.join(", ")} (it has: ${tools.map((t) => t.name).join(", ")})`);
    }
    for (const tool of offered) {
      const name = `${server.name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      const { $schema: _, ...parameters } = tool.inputSchema as Record<string, unknown>;
      // Servers declare read-only tools; anything else might change things, so the model should ask first.
      const readOnly = tool.annotations?.readOnlyHint === true;
      const description = `${readOnly ? "" : "(Takes action: confirm with the user first.) "}${tool.description ?? tool.title ?? tool.name}`.trim();
      this.routes.set(name, { server, tool: tool.name });
      this.defs = [
        ...this.defs.filter((d) => d.type !== "function" || d.function.name !== name),
        { type: "function", function: { name, description: description.slice(0, MAX_DESCRIPTION), parameters } },
      ];
    }
    this.log(`mcp ${server.name}: ${offered.length} tool(s) ${offered.map((t) => t.name).join(", ")}`);
  }
}
