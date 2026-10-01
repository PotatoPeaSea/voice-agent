import type { VoiceConnection } from "@discordjs/voice";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ChatMessage, ChatModel } from "../llm/chat.js";
import type { Speaker } from "../bot/speaker.js";
import { listenToUser } from "../bot/listener.js";
import type { SttEvent, SttProvider } from "../speech/types.js";
import type { ListenMode } from "./listen-mode.js";
import { chunkSentences } from "./sentences.js";
import { assistantTurn, type TurnTools } from "./turn.js";
import type { ToolContext } from "./tools.js";

const MAX_HISTORY = 40; // messages kept besides the system prompt
const STT_IDLE_CLOSE_MS = 30_000; // stop streaming to STT after this much silence (saves cost)
const STT_RETRY_MS = 2_000;
const NOTICE_CHECK_MS = 1_000;

export type SessionTools = TurnTools;

/** Handled by the session itself: clears the conversation once the current reply is done. */
export const NEW_CONVERSATION_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "new_conversation",
    description:
      "Start a fresh conversation: forget everything said so far. Use when the user asks to start over, start a new chat or clear the context. Tasks keep running and stay listed.",
    parameters: { type: "object", properties: {} },
  },
};

/** Offered only in interrupt mode: stops responding until the wake word is heard again. */
export const GO_QUIET_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "go_quiet",
    description:
      "Stop listening until the user says the wake word again. Use when the user is done talking for now, e.g. \"ok we're done\", \"that's all for now\", \"thanks, bye\". The conversation is kept and tasks keep running.",
    parameters: { type: "object", properties: {} },
  },
};

export interface SessionDeps {
  connection: VoiceConnection;
  userId: string;
  speaker: Speaker;
  chat: ChatModel;
  makeStt: () => SttProvider;
  /** Turn streamed sentences into 48kHz stereo PCM with the active voice (resolved per reply). */
  speak: (text: AsyncIterable<string>, signal: AbortSignal) => AsyncIterable<Buffer>;
  tools?: SessionTools;
  /** The conversation so far; pass the same array again to carry it over when the bot rejoins a call. */
  history?: ChatMessage[];
  /** Called when speech recognition hears the user start a turn (not on mere mic noise). */
  onTurnStart?: () => void;
  /** Starting mode (default "default"); change it with setMode(). Interrupt mode needs `wakeWord`. */
  mode?: ListenMode;
  /**
   * For interrupt mode: ignore everything the user says until a turn contains one of these phrases,
   * then converse normally until `idleMs` pass with nothing said (then wait for the phrase again).
   */
  wakeWord?: { phrases: string[]; idleMs: number };
  log: (...a: unknown[]) => void;
  verbose: boolean;
}

type Input = { kind: "user"; text: string } | { kind: "notice"; text: string };

/**
 * One user's conversation: streaming STT -> LLM (with tool calls) -> sentence
 * chunks -> TTS -> Discord, with barge-in. Background task updates and slow
 * lookups' results are queued and spoken when the conversation is idle.
 */
export class VoiceSession {
  private readonly history: ChatMessage[];
  private readonly tools: SessionTools;
  /** Set by the new_conversation tool; the history is cleared once the confirming reply is done. */
  private resetAfterReply = false;
  private turn?: AbortController;
  /** The in-flight reply; the next one waits for it so history updates never interleave. */
  private current: Promise<void> = Promise.resolve();
  private stt?: AbortController;
  private idleTimer?: NodeJS.Timeout;
  private userSpeaking = false;
  private lastUserText = "";
  private mode: ListenMode = "default";
  /** Responding to the user; false while waiting for the wake word (interrupt mode). */
  private awake = true;
  /** Set by the go_quiet tool; the session stops responding once the goodbye is said. */
  private sleepAfterReply = false;
  private sleepTimer?: NodeJS.Timeout;
  private readonly notices: string[] = [];
  private readonly noticeTimer: NodeJS.Timeout;

  constructor(private readonly deps: SessionDeps) {
    this.history = deps.history ?? [];
    const session = this;
    this.tools = {
      // Re-read every model call, so a /mode switch takes effect mid-conversation.
      get definitions() {
        return [
          ...(deps.tools?.definitions ?? []),
          NEW_CONVERSATION_TOOL,
          ...(session.interrupting ? [GO_QUIET_TOOL] : []),
        ];
      },
      execute: async (name, args, ctx) => {
        if (name === "go_quiet" && this.interrupting) {
          this.sleepAfterReply = true;
          return {
            ok: true,
            note: `After this reply you stop listening until the user says "${this.wakePhrase}". Say a short goodbye.`,
          };
        }
        if (name !== "new_conversation") {
          return deps.tools ? deps.tools.execute(name, args, ctx) : { error: `unknown tool ${name}` };
        }
        this.resetAfterReply = true;
        return { ok: true, note: "The conversation will be cleared after this reply. Confirm in a few words." };
      },
    };
    this.noticeTimer = setInterval(() => this.flushNotices(), NOTICE_CHECK_MS);
    this.setMode(deps.mode ?? "default");
  }

  /**
   * Switch listen mode. Interrupt mode starts out waiting for the wake word (a reply in progress
   * still finishes); default mode responds to everything again.
   */
  setMode(mode: ListenMode): void {
    if (mode === "interrupt" && !this.deps.wakeWord?.phrases.length) throw new Error("interrupt mode needs wake words");
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "interrupt") return this.sleep("interrupt mode");
    this.awake = true;
    this.sleepAfterReply = false;
    clearTimeout(this.sleepTimer);
  }

  /** Forget the conversation now (stopping any reply in progress). Queued task updates are kept. */
  reset(): void {
    this.bargeIn();
    this.history.length = 0;
    // An aborted reply may still be finishing and record what it said; clear again once it has
    // (this runs before any reply queued after the reset).
    void this.current.then(() => (this.history.length = 0));
    this.deps.log("conversation reset");
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
    clearTimeout(this.sleepTimer);
    clearInterval(this.noticeTimer);
  }

  /** Nothing being said, heard or waiting to be said (hold music may play). */
  get quiet(): boolean {
    return this.idle && !this.notices.length;
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

  private get interrupting(): boolean {
    return this.mode === "interrupt";
  }

  private get wakePhrase(): string {
    return this.deps.wakeWord?.phrases[0] ?? "";
  }

  private heardWakeWord(text: string): boolean {
    return !!this.deps.wakeWord && containsWakeWord(text, this.deps.wakeWord.phrases);
  }

  private wakeUp(): void {
    if (!this.awake) this.deps.log("wake word heard, listening");
    this.awake = true;
    this.scheduleSleep();
  }

  /** Stop responding until the wake word is heard again. */
  private sleep(reason: string): void {
    this.awake = false;
    clearTimeout(this.sleepTimer);
    this.deps.log(`${reason}, waiting for the wake word`);
  }

  /** (Re)start the countdown back to waiting for the wake word; a no-op when asleep or not in interrupt mode. */
  private scheduleSleep(): void {
    const wake = this.deps.wakeWord;
    if (!wake || !this.interrupting || !this.awake) return;
    clearTimeout(this.sleepTimer);
    this.sleepTimer = setTimeout(() => {
      if (!this.idle) return this.scheduleSleep();
      this.sleep(`no conversation for ${wake.idleMs / 1000}s`);
      this.sayLine(`Going quiet. Say ${this.wakePhrase} when you need me.`);
    }, wake.idleMs);
  }

  /** Speak a fixed line (no model call), queued after any reply in progress; barge-in stops it. */
  private sayLine(text: string): void {
    const { speaker, speak, log } = this.deps;
    this.turn?.abort();
    const controller = new AbortController();
    this.turn = controller;
    this.current = this.current
      .then(async () => {
        if (controller.signal.aborted) return;
        async function* line() {
          yield text;
        }
        try {
          await speaker.play(speak(line(), controller.signal), () => {});
          log(`bot: ${text}`);
        } catch (err) {
          if (!controller.signal.aborted) log("reply error:", (err as Error).message);
        }
      })
      .catch((err: Error) => log("reply failed:", err.message))
      .finally(() => {
        if (this.turn === controller) this.turn = undefined;
      });
  }

  /** The user started talking to the bot: stop hold music and anything the bot is saying. */
  private userTurnStarted(): void {
    this.deps.onTurnStart?.();
    if (this.turn || this.deps.speaker.isSpeaking) {
      this.deps.log("barge-in");
      this.bargeIn();
    }
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
        // While asleep, wait for the wake word before interrupting anything.
        if (this.awake) this.userTurnStarted();
        break;
      case "partial":
        if (this.deps.verbose) this.deps.log(`… ${event.text}`);
        if (!this.awake && this.heardWakeWord(event.text)) {
          this.wakeUp();
          this.userTurnStarted();
        }
        break;
      case "turn_end":
        this.userSpeaking = false;
        this.resetIdleTimer();
        if (!event.text) break;
        if (!this.awake) {
          if (!this.heardWakeWord(event.text)) {
            if (this.deps.verbose) this.deps.log(`(asleep, ignored) ${event.text}`);
            break;
          }
          this.wakeUp();
          this.userTurnStarted();
        }
        this.scheduleSleep();
        void this.respond({ kind: "user", text: event.text }, lastPacketAt);
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
    const { chat, speaker, log } = this.deps;
    const { tools } = this;
    const { signal } = controller;
    this.addInput(input);
    if (signal.aborted) {
      if (this.turn === controller) this.turn = undefined;
      return;
    }
    const history = this.history;
    const ctx: ToolContext = { userTranscript: this.lastUserText, notify: (text) => this.notify(text) };

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
    if (this.resetAfterReply) {
      this.resetAfterReply = false;
      history.length = 0;
      log("conversation cleared");
    }
    if (this.turn === controller) this.turn = undefined;
    if (this.sleepAfterReply) {
      this.sleepAfterReply = false;
      // A goodbye cut short by the user means they're still talking.
      if (!interrupted && this.interrupting && this.awake) return this.sleep("user is done");
    }
    // Count the idle time from when the bot stops talking, not from when the user did.
    this.scheduleSleep();
  }
}

/** Lowercase words only, so "Hey, Jarvis!" and "hey jarvis" compare equal. */
function words(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, " ").trim();
}

/** Whether `text` contains one of the wake phrases as whole words (ignoring case and punctuation). */
export function containsWakeWord(text: string, phrases: string[]): boolean {
  const heard = ` ${words(text)} `;
  return phrases.some((p) => {
    const phrase = words(p);
    return !!phrase && heard.includes(` ${phrase} `);
  });
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
