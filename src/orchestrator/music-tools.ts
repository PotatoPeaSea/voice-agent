import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { MusicLibrary } from "../audio/music.js";
import { matchSongs, songTitle } from "../audio/songs.js";
import type { HoldMusic } from "../bot/hold-music.js";
import type { Jukebox } from "../bot/jukebox.js";

export const MUSIC_TOOL_DEFINITIONS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "list_songs",
      description:
        "List the songs you can play, or search them by name. Use when the user asks what music there is, or to check which song they mean.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Part of a song name to search for. Omit to list every song." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "play_music",
      description:
        "Play a song in the voice channel. Say a few words first (\"Here's Moonlight.\"); it starts after you finish speaking, " +
        "your later replies pause it and it resumes afterwards, and it ends with the track or stop_music. Replaces any song playing.",
      parameters: {
        type: "object",
        properties: {
          song: { type: "string", description: "The song name as the user said it, even partial or misheard. Omit to play a random song." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_music",
      description:
        "Stop the music (when the user says stop, skip it, turn it off, enough music...). Stops a song they asked for and also the " +
        "hold music that plays by itself while agents work and nobody is talking; hold music stays off until those agents finish.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const NAMES = new Set(MUSIC_TOOL_DEFINITIONS.map((t) => (t.type === "function" ? t.function.name : "")));

export interface MusicToolsDeps {
  library: Pick<MusicLibrary, "tracks">;
  /** The current call's jukebox; undefined when not in a voice channel. */
  jukebox: () => Jukebox | undefined;
  /** The current call's hold music (plays by itself while agents work); undefined when there is none. */
  holdMusic?: () => Pick<HoldMusic, "mute"> | undefined;
}

/** Executes the front model's music tool calls: songs from the music folder, played into the call. */
export class MusicTools {
  readonly definitions = MUSIC_TOOL_DEFINITIONS;

  constructor(private readonly deps: MusicToolsDeps) {}

  handles(name: string): boolean {
    return NAMES.has(name);
  }

  execute(name: string, rawArgs: string): unknown {
    let args: Record<string, string>;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { error: `arguments were not valid JSON: ${rawArgs.slice(0, 120)}${rawArgs.length > 120 ? "…" : ""}` };
    }
    const songs = this.deps.library.tracks();
    const nowPlaying = this.deps.jukebox()?.current;
    switch (name) {
      case "list_songs": {
        if (!songs.length) return { songs: [], note: "The music folder has no songs." };
        const all = songs.map(songTitle);
        if (!args.query?.trim()) return { songs: all, ...(nowPlaying ? { now_playing: nowPlaying } : {}) };
        const matches = matchSongs(args.query, songs).map((m) => m.title);
        return matches.length ? { query: args.query, matches } : { query: args.query, matches: [], all_songs: all };
      }
      case "play_music": {
        const jukebox = this.deps.jukebox();
        if (!jukebox) return { error: "Not in a voice channel, so there's nowhere to play music." };
        if (!songs.length) return { error: "There are no songs in the music folder." };
        const wanted = args.song?.trim();
        const match = wanted ? matchSongs(wanted, songs)[0] : undefined;
        if (wanted && !match) {
          return { error: `No song matches "${wanted}". Tell the user and offer these instead.`, available: songs.map(songTitle) };
        }
        const file = match?.file ?? songs[Math.floor(Math.random() * songs.length)]!;
        const title = songTitle(file);
        jukebox.play(file, title);
        return { ok: true, playing: title, ...(match && match.score < 1 ? { matched: wanted } : {}), note: "Starts when you finish speaking." };
      }
      case "stop_music": {
        const song = this.deps.jukebox()?.stop();
        const hold = this.deps.holdMusic?.()?.mute() ? "hold music" : undefined;
        if (song) return { ok: true, stopped: song, ...(hold ? { also_stopped: hold } : {}) };
        return hold ? { ok: true, stopped: hold } : { ok: true, note: "No music was playing." };
      }
      default:
        return { error: `unknown tool ${name}` };
    }
  }
}
