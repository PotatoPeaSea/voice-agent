import type { TaskReport } from "./types.js";

const MARKER = "VOICE SUMMARY:";

export interface Brief {
  goal: string;
  cwd: string;
  doneWhen?: string;
  constraints?: string;
  /** The user's words verbatim, so nothing is lost to the front model's paraphrase. */
  userTranscript?: string;
}

/** The prompt sent to the worker agent: structured brief + raw transcript + report format. */
export function buildBrief(brief: Brief): string {
  const lines = [brief.goal, "", "Context:", `- Working directory: ${brief.cwd}`];
  if (brief.constraints) lines.push(`- Constraints: ${brief.constraints}`);
  if (brief.doneWhen) lines.push(`- Done when: ${brief.doneWhen}`);
  if (brief.userTranscript) {
    lines.push(
      "",
      "This task was requested by voice. The user's exact words (speech recognition, may contain errors):",
      `"${brief.userTranscript}"`,
    );
  }
  lines.push("", REPORT_INSTRUCTIONS);
  return lines.join("\n");
}

/** Appended to every prompt so each turn ends with something speakable. */
export const REPORT_INSTRUCTIONS = [
  `When you finish, end your final message with a section that starts with "${MARKER}" followed by`,
  "one plain sentence suitable for reading aloud, then up to 5 short bullet points.",
  "If you are blocked or need a decision from the user, say so in that sentence.",
].join(" ");

/** Split the agent's final message into headline / bullets / full text. */
export function parseReport(text: string): TaskReport {
  const full = text.trim();
  const at = full.lastIndexOf(MARKER);
  if (at < 0) {
    const firstSentence = full.split(/(?<=[.!?])\s/)[0] ?? "";
    return { headline: firstSentence.slice(0, 300) || "Finished with no message.", bullets: [], full };
  }
  const summary = full
    .slice(at + MARKER.length)
    .split("\n")
    .map((l) => l.trim().replace(/^[*_#]+\s*(?=\S)/, "")) // markdown left over from "**VOICE SUMMARY:**"
    .filter((l) => l && !/^[*_#]+$/.test(l));
  const bulletRe = /^[-*•]\s+|^\d+[.)]\s+/;
  const headline = summary.find((l) => !bulletRe.test(l)) ?? summary[0]?.replace(bulletRe, "") ?? "";
  const bullets = summary.filter((l) => bulletRe.test(l)).map((l) => l.replace(bulletRe, "")).slice(0, 5);
  return { headline: stripMarkdown(headline), bullets: bullets.map(stripMarkdown), full };
}

function stripMarkdown(text: string): string {
  return text.replace(/\*\*|__|`/g, "").trim();
}
