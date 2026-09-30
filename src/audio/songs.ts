import { basename, extname } from "node:path";

/** Below this a song isn't considered a match at all. */
const MIN_SCORE = 0.65;
/** Words people say around a song name ("play the song Moonlight please"), ignored when matching. */
const FILLER = new Set(["a", "an", "the", "play", "song", "track", "tune", "music", "called", "named", "please", "some", "me", "by"]);

/** A song's spoken name: its file name without the extension, separators as spaces. */
export function songTitle(file: string): string {
  return basename(file, extname(file)).replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
}

export interface SongMatch {
  file: string;
  title: string;
  /** 0-1; 1 is an exact match. */
  score: number;
}

/**
 * Songs whose names match what the user said, best first. Speech recognition
 * mangles names, so this ignores case, punctuation, spacing and filler words,
 * and accepts partial names ("moon"), extra words ("moonlight sonata") and
 * near-misses ("greatful").
 */
export function matchSongs(query: string, files: string[]): SongMatch[] {
  const wanted = words(query).filter((w) => !FILLER.has(w));
  if (!wanted.length) return [];
  return files
    .map((file) => ({ file, title: songTitle(file), score: score(wanted, words(songTitle(file))) }))
    .filter((m) => m.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function score(wanted: string[], title: string[]): number {
  const name = title.filter((w) => !FILLER.has(w));
  const q = wanted.join("");
  const t = (name.length ? name : title).join("");
  if (!t) return 0;
  if (q === t) return 1;
  // Part of the name, or the name plus extra words.
  if (Math.min(q.length, t.length) >= 3 && (t.includes(q) || q.includes(t))) return 0.9;
  // Word by word, so word order and a misheard word don't sink the match.
  const perWord = wanted.map((w) => Math.max(0, ...title.map((n) => wordSimilarity(w, n))));
  const byWords = (0.85 * perWord.reduce((a, b) => a + b, 0)) / perWord.length;
  return Math.max(byWords, similarity(q, t));
}

function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 3 && b.startsWith(a)) return 0.9;
  return similarity(a, b);
}

/** 1 - edit distance / length of the longer string. */
function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - levenshtein(a, b) / longest : 1;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** Lowercase words without accents or punctuation ("Don't" -> "dont"). */
function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
