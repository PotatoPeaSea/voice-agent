/**
 * `npm run acp:probe` — start Claude Code over ACP, open a throwaway session
 * and print what it supports (auth, modes, models, effort levels).
 */
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { createRequire } from "node:module";
import * as acp from "@agentclientprotocol/sdk";

const require = createRequire(import.meta.url);
const adapter = require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
const child = spawn(process.execPath, [adapter], { stdio: ["pipe", "pipe", "inherit"] });
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);

const connection = new acp.ClientSideConnection(
  () => ({
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async () => {},
  }),
  stream,
);

const init = await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
console.log("agent:", init.agentInfo?.name, init.agentInfo?.version, "protocol", init.protocolVersion);
console.log("auth methods:", init.authMethods?.map((m) => m.id).join(", ") || "none");

const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
console.log("session:", session.sessionId);
for (const option of session.configOptions ?? []) {
  const values = option.type === "select" ? option.options.flatMap((o) => ("options" in o ? o.options : [o])) : [];
  console.log(
    `\n[${option.id}] ${option.name} = ${String(option.currentValue)}\n` +
      values.map((v) => `   ${v.value}${v.description ? ` — ${v.description}` : ""}`).join("\n"),
  );
}
child.kill();
process.exit(0);
