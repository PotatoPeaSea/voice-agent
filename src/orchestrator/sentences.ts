/**
 * Groups streamed LLM tokens into speakable chunks so TTS can start on the
 * first sentence while the rest is still being generated.
 *
 * Emits on sentence punctuation. The first chunk may also be cut at a clause
 * boundary (comma, dash, colon) once it is long enough, to get audio out sooner.
 */
const SENTENCE_END = /[.!?…]+["')\]]*(?=\s)/;
const CLAUSE_END = /[,;:—–]\s/;
const FIRST_CLAUSE_MIN_CHARS = 40;

export async function* chunkSentences(tokens: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = "";
  let emitted = 0;

  for await (const token of tokens) {
    buffer += token;
    while (true) {
      const sentence = SENTENCE_END.exec(buffer);
      let cut = sentence ? sentence.index + sentence[0].length : -1;

      if (cut < 0 && emitted === 0 && buffer.length >= FIRST_CLAUSE_MIN_CHARS) {
        const clause = CLAUSE_END.exec(buffer.slice(FIRST_CLAUSE_MIN_CHARS - 10));
        if (clause) cut = FIRST_CLAUSE_MIN_CHARS - 10 + clause.index + 1;
      }
      if (cut < 0) break;

      const chunk = clean(buffer.slice(0, cut));
      buffer = buffer.slice(cut);
      if (chunk) {
        emitted++;
        yield chunk;
      }
    }
  }

  const rest = clean(buffer);
  if (rest) yield rest;
}

/** Strip markdown the model might emit anyway; TTS would read it aloud. */
function clean(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
