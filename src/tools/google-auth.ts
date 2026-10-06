/**
 * `npm run google:auth` — authorize the Google Workspace MCP server (config/mcp.yaml, "google") once, from your
 * browser, instead of by voice. It starts the server the way the bot does, makes a harmless read call, opens the
 * Google consent page it asks for, and keeps the server up until you've approved so its local callback can receive
 * the answer. The token is then cached by the server and the bot reuses it.
 */
import "dotenv/config";
import { exec } from "node:child_process";
import { McpTools } from "../lookup/mcp.js";

const SERVER = "google";
const PROBE_TOOL = `${SERVER}__list_calendars`;
const WAIT_MS = 5 * 60_000;
const POLL_MS = 4_000;

const log = (...a: unknown[]) => console.log(...a);
const mcp = McpTools.fromFile(process.env.MCP_CONFIG?.trim() || "config/mcp.yaml", log);
await mcp.connect();

if (!mcp.handles(PROBE_TOOL)) {
  console.error(
    `\nThe "${SERVER}" server isn't available (see the "mcp ${SERVER}:" line above). It needs GOOGLE_OAUTH_CLIENT_ID, ` +
      "GOOGLE_OAUTH_CLIENT_SECRET and USER_GOOGLE_EMAIL in .env, and `enabled` not set to false in config/mcp.yaml.",
  );
  await mcp.close();
  process.exit(1);
}

function openInBrowser(url: string): void {
  const command = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}

const shown = new Set<string>();
const deadline = Date.now() + WAIT_MS;
let authorized = false;
while (Date.now() < deadline) {
  const reply = (await mcp.execute(PROBE_TOOL, "{}", { userTranscript: "" })) as { result?: string; error?: string };
  const text = reply.result ?? reply.error ?? "";
  const needsAuth = /authoriz|authenticat|consent|sign[ -]?in/i.test(text) && /https?:\/\//.test(text);
  if (!needsAuth && !reply.error) {
    authorized = true;
    console.log(`\nAuthorized. Google replied:\n${text.slice(0, 600)}`);
    break;
  }
  const url = /https?:\/\/[^\s)>\]"']+/.exec(text)?.[0];
  if (url && !shown.has(url)) {
    shown.add(url);
    console.log(`\nOpening the Google consent page. If it doesn't open, paste this into your browser:\n${url}\n\nWaiting for you to approve (up to 5 minutes)...`);
    openInBrowser(url);
  } else if (reply.error && !url && !shown.has(reply.error)) {
    shown.add(reply.error);
    console.log(`\nGoogle server said: ${reply.error.slice(0, 600)}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

await mcp.close();
if (!authorized) {
  console.error("\nNot authorized yet (timed out or the server reported an error above). Run it again once that's fixed.");
  process.exit(1);
}
console.log("Done. Restart the bot (or just start it) and it can use Gmail, Calendar, Drive and Docs.");
process.exit(0);
