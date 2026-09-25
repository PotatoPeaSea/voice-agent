import { PassThrough } from "node:stream";
import { once } from "node:events";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";

/**
 * Plays streamed 48kHz stereo PCM into a voice connection.
 * Gaps in the stream (TTS still generating) are filled with silence instead of
 * ending playback; playback ends when the stream ends or stop() is called.
 */
export class Speaker {
  private readonly player: AudioPlayer;
  private current?: PassThrough;

  constructor(connection: VoiceConnection, private readonly log: (...a: unknown[]) => void) {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: Infinity },
    });
    this.player.on("error", (err) => log("player error:", err.message));
    connection.subscribe(this.player);
  }

  get isSpeaking(): boolean {
    return this.player.state.status !== AudioPlayerStatus.Idle;
  }

  /** Play a short burst of silence so the Opus encoder is initialized before the first real reply. */
  async warmUp(): Promise<void> {
    async function* silence() {
      yield Buffer.alloc(48_000 * 4 * 0.2);
    }
    await this.play(silence());
  }

  /**
   * Stream PCM to Discord. Resolves when playback finishes or is stopped.
   * onFirstAudio fires when audio actually starts going out.
   */
  async play(pcm: AsyncIterable<Buffer>, onFirstAudio?: () => void): Promise<void> {
    this.stop();
    const stream = new PassThrough({ highWaterMark: 48_000 * 4 }); // ~1s buffer
    this.current = stream;
    this.player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
    if (onFirstAudio) this.player.once(AudioPlayerStatus.Playing, onFirstAudio);

    const finished = new Promise<void>((resolve) => {
      const onIdle = () => {
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        resolve();
      };
      this.player.on(AudioPlayerStatus.Idle, onIdle);
    });

    try {
      for await (const chunk of pcm) {
        if (stream.destroyed) break;
        if (!stream.write(chunk)) await Promise.race([once(stream, "drain"), once(stream, "close")]);
      }
    } catch (err) {
      this.log("audio source error:", (err as Error).message);
    } finally {
      if (!stream.destroyed) stream.end();
    }
    await finished;
    if (onFirstAudio) this.player.off(AudioPlayerStatus.Playing, onFirstAudio);
  }

  /** Stop immediately (barge-in). */
  stop(): void {
    if (this.current && !this.current.destroyed) this.current.destroy();
    this.current = undefined;
    if (this.player.state.status !== AudioPlayerStatus.Idle) this.player.stop(true);
  }
}
