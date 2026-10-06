#!/usr/bin/env node
/**
 * Claude Code hook that shares the voice agent's long-term memory (the memory-core gateway at MEMORY_URL).
 *
 *   node claude-memory-hook.mjs recall    UserPromptSubmit: adds a few relevant memories to the prompt's context
 *   node claude-memory-hook.mjs capture   Stop: saves the last exchange to memory
 *
 * Small on purpose: recall adds at most 3 memories of 300 characters (about 250 tokens), and only when something
 * matches. It never blocks or fails a prompt: a slow or unreachable server (2.5s limit) just means no memories.
 * Settings come from the environment or the voice agent's .env (MEMORY_URL, MEMORY_API_KEY, MEMORY_AGENT_ID).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 2_500;
const MAX_HITS = 3;
const MAX_HIT_CHARS = 300;
const MIN_PROMPT_CHARS = 12;

function envFileValues() {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = process.env.MEMORY_ENV_FILE || join(here, "..", ".env");
  const values = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(MEMORY_URL|MEMORY_API_KEY|MEMORY_AGENT_ID)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env: environment only */
  }
  return values;
}

const fromFile = envFileValues();
const setting = (name) => (process.env[name] || fromFile[name] || "").trim();

async function post(path, body) {
  const base = setting("MEMORY_URL").replace(/\/+$/, "");
  if (!base) throw new Error("MEMORY_URL is not set");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${setting("MEMORY_API_KEY") || "local"}`, "x-tdai-service-id": "default" },
    body: JSON.stringify({ team_id: "default", user_id: "default", agent_id: setting("MEMORY_AGENT_ID") || "shared", ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gateway answered ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`gateway error ${json.code}`);
  return json.data ?? {};
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}…`);

async function recall(input) {
  const prompt = String(input.prompt ?? "").trim();
  if (prompt.length < MIN_PROMPT_CHARS) return;
  const query = prompt.slice(0, 300);
  const [facts, talk] = await Promise.allSettled([
    post("/v3/atomic/search", { query, limit: MAX_HITS }),
    post("/v3/conversation/search", { query, limit: MAX_HITS }),
  ]);
  const hits = [
    ...(facts.status === "fulfilled" ? (facts.value.items ?? []).map((i) => ({ text: i.content, score: i.score ?? 0 })) : []),
    ...(talk.status === "fulfilled" ? (talk.value.messages ?? []).map((m) => ({ text: m.content, score: m.score ?? 0 })) : []),
  ]
    .filter((h) => h.text && !h.text.startsWith(prompt.slice(0, 40))) // not the prompt echoing back from a past capture
    .sort((a, b) => b.score - a.score)
    .filter((h, i, all) => all.findIndex((o) => o.text === h.text) === i)
    .slice(0, MAX_HITS);
  if (!hits.length) return;
  // UserPromptSubmit stdout is added to Claude's context.
  console.log(`<shared-memory note="From the user's shared long-term memory; use only if relevant.">\n${hits.map((h) => `- ${clip(h.text.replace(/\s+/g, " "), MAX_HIT_CHARS)}`).join("\n")}\n</shared-memory>`);
}

/** The text of the last assistant message in a Claude Code transcript (JSON lines). */
export function lastAssistantText(transcript) {
  const lines = transcript.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== "assistant") continue;
      const content = entry.message?.content;
      const text = Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : String(content ?? "");
      if (text.trim()) return text.trim();
    } catch {
      /* skip a damaged line */
    }
  }
  return "";
}

/** The text of the last real user prompt in a transcript (not tool results). */
export function lastUserText(transcript) {
  const lines = transcript.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== "user") continue;
      const content = entry.message?.content;
      const text = Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : String(content ?? "");
      if (text.trim() && !text.startsWith("<system-reminder>")) return text.trim();
    } catch {
      /* skip a damaged line */
    }
  }
  return "";
}

async function capture(input) {
  let transcript = "";
  try {
    transcript = readFileSync(String(input.transcript_path ?? ""), "utf8");
  } catch {
    return;
  }
  const user = lastUserText(transcript);
  const assistant = lastAssistantText(transcript);
  const messages = [
    ...(user ? [{ role: "user", content: clip(user, 8000), timestamp: new Date().toISOString() }] : []),
    ...(assistant ? [{ role: "assistant", content: clip(assistant, 8000), timestamp: new Date().toISOString() }] : []),
  ];
  if (!messages.length) return;
  await post("/v3/conversation/add", { session_id: `claude-${input.session_id ?? "session"}`, messages });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  try {
    if (!setting("MEMORY_URL")) process.exit(0); // not configured: do nothing, silently
    const input = await readStdin();
    if (mode === "recall") await recall(input);
    else if (mode === "capture") await capture(input);
  } catch {
    /* never get in the way of a prompt */
  }
  process.exit(0);
}
