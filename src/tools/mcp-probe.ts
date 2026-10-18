/**
 * List the tools an MCP server offers: npm run mcp:probe -- <command> [args...]
 * or, for a remote server, npm run mcp:probe -- <https://url>  (sends "Authorization: Bearer $PROBE_TOKEN" and
 * "X-MCP-Readonly: true" when PROBE_TOKEN is set).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: npm run mcp:probe -- <command> [args...]");
  process.exit(1);
}
const client = new Client({ name: "mcp-probe", version: "0.1.0" });
const token = process.env.PROBE_TOKEN;
await client.connect(
  command.startsWith("http")
    ? new StreamableHTTPClientTransport(new URL(command), {
        requestInit: { headers: token ? { Authorization: `Bearer ${token}`, "X-MCP-Readonly": "true" } : {} },
      })
    : new StdioClientTransport({ command, args, stderr: "inherit" }),
);
const { tools } = await client.listTools();
for (const t of tools) console.log(`${t.name}${t.annotations?.readOnlyHint ? " [read-only]" : ""}: ${(t.description ?? "").split("\n")[0]?.slice(0, 110)}`);
await client.close();
