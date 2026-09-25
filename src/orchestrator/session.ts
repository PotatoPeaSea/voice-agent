import type { VoiceConnection } from "@discordjs/voice";
import type { ChatMessage, ChatModel } from "../llm/chat.js";
import type { Speaker } from "../bot/speaker.js";
import { listenToUser } from "../bot/listener.js";
import type { SttEvent, SttProvider } from "../speech/types.js";
import { chunkSentences } from "./sentences.js";
import { assistantTurn, type TurnTools } from "./turn.js";
import type { ToolContext } from "./tools.js";

const MAX_HISTORY = 40; // messages kept besides the system prompt
const STT_IDLE_CLOSE_MS = 30_000; // stop streaming to STT after this much silence (saves cost)
const STT_RETRY_MS = 2_000;
const NOTICE_CHECK_MS = 1_000;

export type SessionTools = TurnTools;

export interface SessionDeps {
  connection: VoiceConnection;
  userId: string;
  speaker: Speaker;
  chat: ChatModel;
  makeStt: () => SttProvider;
  /** Turn streamed sentences into 48kHz stereo PCM with the active voice (resolved per reply). */
  speak: (text: AsyncIterable<string>, signal: AbortSignal) => AsyncIterable<Buffer>;
  tools?: SessionTools;
  log: (...a: unknown[]) => void;
  verbose: boolean;
}

type Input = { kind: "user"; text: string } | { kind: "notice"; text: string };

/**
 * One user's conversation: streaming STT -> LLM (with tool calls) -> sentence
 * chunks -> TTS -> Discord, with barge-in. Background task updates are queued
 * and spoken when the conversation is idle.
 */
export class VoiceSession {
  private history: ChatMessage[] = [];
  private turn?: AbortController;
  /** The in-flight reply; the next one waits for it so history updates never interleave. */
  private current: Promise<void> = Promise.resolve();
  private stt?: AbortController;
  private idleTimer?: NodeJS.Timeout;
  private userSpeaking = false;
  private lastUserText = "";
  private readonly notices: string[] = [];
  private readonly noticeTimer: NodeJS.Timeout;

  constructor(private readonly deps: SessionDeps) {
    this.noticeTimer = setInterval(() => this.flushNotices(), NOTICE_CHECK_MS);
  }

  /** Called when Discord reports the user speaking. Opens the STT stream if it's closed. */
  wake(): void {
    this.resetIdleTimer();
    if (this.stt) return;
    const controller = new AbortController();
    this.stt = controller;
    void this.runStt(controller);
  }

  /** Queue something to tell the user (e.g. a task finished); spoken at the next quiet moment. */
  notify(text: string): void {
    this.notices.push(text);
    this.flushNotices();
  }

  close(): void {
    this.bargeIn();
    this.stt?.abort();
    this.stt = undefined;
    clearTimeout(this.idleTimer);
    clearInterval(this.noticeTimer);
  }

  private get idle(): boolean {
    return !this.turn && !this.userSpeaking && !this.deps.speaker.isSpeaking;
  }

  private flushNotices(): void {
    if (!this.notices.length || !this.idle) return;
    const text = this.notices.splice(0).join("\n");
    void this.respond({ kind: "notice", text }, 0);
  }

  private resetIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.idle) return this.resetIdleTimer();
      this.deps.log("stt idle, closing stream");
      this.stt?.abort();
      this.stt = undefined;
    }, STT_IDLE_CLOSE_MS);
  }

  private async runStt(controller: AbortController): Promise<void> {
    const { connection, userId, log } = this.deps;
    const user = listenToUser(connection, userId, controller.signal, log);
    try {
      for await (const event of this.deps.makeStt().transcribe(user.audio, controller.signal)) {
        this.onSttEvent(event, user.lastPacketAt());
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      log("stt error:", (err as Error).message);
      controller.abort();
      if (this.stt === controller) {
        this.stt = undefined;
        setTimeout(() => this.wake(), STT_RETRY_MS);
      }
    }
  }

  private onSttEvent(event: SttEvent, lastPacketAt: number): void {
    switch (event.type) {
      case "turn_start":
        this.userSpeaking = true;
        if (this.turn || this.deps.speaker.isSpeaking) {
          this.deps.log("barge-in");
          this.bargeIn();
        }
        break;
      case "partial":
        if (this.deps.verbose) this.deps.log(`… ${event.text}`);
        break;
      case "turn_end":
        this.userSpeaking = false;
        this.resetIdleTimer();
        if (event.text) void this.respond({ kind: "user", text: event.text }, lastPacketAt);
        break;
    }
  }

  private bargeIn(): void {
    this.turn?.abort();
    this.turn = undefined;
    this.deps.speaker.stop();
  }

  private addInput(input: Input): void {
    if (input.kind === "notice") {
      this.history.push({ role: "user", content: `[Automatic update, not spoken by the user]\n${input.text}` });
      this.deps.log(`notice: ${input.text}`);
      return;
    }
    this.lastUserText = input.text;
    // If the previous user turn never got a reply (interrupted before speaking), merge them.
    const last = this.history.at(-1);
    if (last?.role === "user" && typeof last.content === "string" && !last.content.startsWith("[Automatic")) {
      last.content = `${last.content} ${input.text}`;
    } else {
      this.history.push({ role: "user", content: input.text });
    }
    this.deps.log(`you: ${input.text}`);
  }

  private respond(input: Input, speechEndedAt: number): Promise<void> {
    this.turn?.abort();
    const controller = new AbortController();
    this.turn = controller;
    const previous = this.current;
    this.current = previous
      .then(() => this.reply(input, speechEndedAt, controller))
      .catch((err: Error) => this.deps.log("reply failed:", err.message));
    return this.current;
  }

  private async reply(input: Input, speechEndedAt: number, controller: AbortController): Promise<void> {
    const { chat, speaker, log, tools } = this.deps;
    const { signal } = controller;
    this.addInput(input);
    if (signal.aborted) {
      if (this.turn === controller) this.turn = undefined;
      return;
    }
    const history = this.history;
    const ctx: ToolContext = { userTranscript: this.lastUserText };

    const t0 = Date.now();
    const marks: Record<string, number> = {};
    const mark = (name: string) => (marks[name] ??= Date.now() - t0);
    const spoken: string[] = [];
    let finalText = "";

    // LLM rounds (with tool calls) stream straight into speech.
    async function* tokens() {
      const turn = assistantTurn({ chat, history, tools, ctx, signal, log, onFinal: (text) => (finalText = text) });
      for await (const token of turn) {
        mark("llm");
        yield token;
      }
    }
    async function* sentences() {
      for await (const sentence of chunkSentences(tokens())) {
        mark("sentence");
        spoken.push(sentence);
        yield sentence;
      }
    }

    try {
      const speak = this.deps.speak;
      async function* audio() {
        for await (const pcm of speak(sentences(), signal)) {
          mark("tts");
          yield pcm;
        }
      }
      await speaker.play(audio(), () => {
        mark("play");
        if (input.kind !== "user") return;
        const endOfSpeech = speechEndedAt ? t0 - speechEndedAt : NaN;
        log(
          `latency: speech end→turn end ${endOfSpeech}ms | llm ${marks.llm}ms | first sentence ${marks.sentence}ms | ` +
            `tts ${marks.tts}ms | playing ${marks.play}ms | total ${Number.isNaN(endOfSpeech) ? "?" : endOfSpeech + marks.play}ms`,
        );
      });
    } catch (err) {
      if (!signal.aborted) log("reply error:", (err as Error).message);
    }

    const interrupted = signal.aborted;
    const said = interrupted ? spoken.join(" ") : finalText;
    if (said) {
      history.push({ role: "assistant", content: interrupted ? `${said} [interrupted by user]` : said });
      log(`bot${interrupted ? " (interrupted)" : ""}: ${said}`);
    }
    trimHistory(history, MAX_HISTORY);
    if (this.turn === controller) this.turn = undefined;
  }
}

/**
 * Trim in place to roughly the last `max` messages, cutting only at a user
 * message so an assistant tool call is never separated from its results.
 */
export function trimHistory(history: ChatMessage[], max: number): void {
  if (history.length <= max) return;
  let start = history.length - max;
  while (start < history.length && history[start].role !== "user") start++;
  history.splice(0, start);
}
