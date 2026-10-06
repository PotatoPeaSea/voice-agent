const SEARCH_TIMEOUT_MS = 3_000;
const CAPTURE_TIMEOUT_MS = 8_000;
const MAX_MESSAGE_CHARS = 8_000;
/** After this many failures in a row, stop calling the service for a while so a dead server never slows a reply. */
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 60_000;

export interface MemoryHit {
  /** A distilled fact (L1) or a line from a past conversation (L0). */
  kind: "fact" | "conversation";
  text: string;
  score?: number;
  when?: string;
  /** For conversation lines: who said it. */
  role?: string;
}

export interface MemoryClientOptions {
  /** Base URL of the memory-core gateway, e.g. http://potatoserver:8420. */
  url: string;
  apiKey?: string;
  /** Memory is shared when agents use the same ids. */
  teamId?: string;
  agentId?: string;
  userId?: string;
  log?: (...a: unknown[]) => void;
  /** Test hook. */
  fetch?: typeof fetch;
}

interface Envelope<T> {
  code: number;
  message?: string;
  data?: T;
}

/**
 * Client for the shared memory service (TencentDB-Agent-Memory's memory-core gateway): saves what's said as
 * raw conversation and searches both distilled facts and past conversation. Every call has a short timeout and
 * fails soft, so a slow or unreachable server costs the conversation nothing.
 */
export class MemoryClient {
  private readonly base: string;
  private readonly ids: { team_id: string; agent_id: string; user_id: string };
  private readonly doFetch: typeof fetch;
  private readonly log: (...a: unknown[]) => void;
  private failures = 0;
  private pausedUntil = 0;

  constructor(private readonly opts: MemoryClientOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.ids = { team_id: opts.teamId ?? "default", agent_id: opts.agentId ?? "shared", user_id: opts.userId ?? "default" };
    this.doFetch = opts.fetch ?? fetch;
    this.log = opts.log ?? (() => {});
  }

  /** False while the breaker is open (the server failed several times in a row). */
  get available(): boolean {
    return Date.now() >= this.pausedUntil;
  }

  private async post<T>(path: string, body: object, timeoutMs: number): Promise<T> {
    if (!this.available) throw new Error("memory service is unreachable right now");
    try {
      const res = await this.doFetch(`${this.base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey || "local"}`,
          "x-tdai-service-id": "default",
        },
        body: JSON.stringify({ ...this.ids, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`memory service answered ${res.status}`);
      const json = (await res.json()) as Envelope<T>;
      if (json.code !== 0) throw new Error(`memory service error ${json.code}: ${json.message ?? ""}`);
      this.failures = 0;
      return json.data as T;
    } catch (err) {
      if (++this.failures >= BREAKER_FAILURES) {
        this.pausedUntil = Date.now() + BREAKER_PAUSE_MS;
        this.failures = 0;
        this.log(`memory: service failing; pausing calls for ${BREAKER_PAUSE_MS / 1000}s (${(err as Error).message})`);
      }
      throw err;
    }
  }

  /** Facts and past conversation matching the query, best first. Throws if the service can't be reached. */
  async search(query: string, limit = 5): Promise<MemoryHit[]> {
    const q = query.trim().slice(0, 2000);
    if (!q) return [];
    const [facts, talk] = await Promise.allSettled([
      this.post<{ items?: { content: string; type?: string; score?: number }[] }>("/v3/atomic/search", { query: q, limit }, SEARCH_TIMEOUT_MS),
      this.post<{ messages?: { content: string; role?: string; score?: number; timestamp?: string; recorded_at?: string }[] }>(
        "/v3/conversation/search",
        { query: q, limit },
        SEARCH_TIMEOUT_MS,
      ),
    ]);
    if (facts.status === "rejected" && talk.status === "rejected") throw facts.reason;
    const hits: MemoryHit[] = [
      ...(facts.status === "fulfilled" ? (facts.value?.items ?? []) : []).map((i): MemoryHit => ({ kind: "fact", text: i.content, score: i.score })),
      ...(talk.status === "fulfilled" ? (talk.value?.messages ?? []) : []).map(
        (m): MemoryHit => ({ kind: "conversation", text: m.content, score: m.score, role: m.role, when: m.timestamp ?? m.recorded_at }),
      ),
    ];
    const seen = new Set<string>();
    return hits
      .filter((h) => h.text && !seen.has(h.text) && !!seen.add(h.text))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);
  }

  /** Save messages as raw conversation. Fire and forget: failures are logged, never thrown. */
  capture(sessionId: string, messages: { role: "user" | "assistant"; content: string }[]): void {
    const clean = messages
      .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_MESSAGE_CHARS), timestamp: new Date().toISOString() }))
      .filter((m) => m.content);
    if (!clean.length || !this.available) return;
    this.post("/v3/conversation/add", { session_id: sessionId, messages: clean }, CAPTURE_TIMEOUT_MS).catch((err: Error) =>
      this.log(`memory: couldn't save the conversation (${err.message})`),
    );
  }

  /** True if the gateway answers its health check. */
  async healthy(): Promise<boolean> {
    try {
      const res = await this.doFetch(`${this.base}/health`, { signal: AbortSignal.timeout(3_000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
