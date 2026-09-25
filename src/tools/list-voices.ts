/** `npm run voices -- <provider>` — list voice IDs to paste into config/voices.yaml. */
import { loadEnv } from "../config.js";
import { getTts } from "../speech/index.js";

const provider = process.argv[2];
if (!provider) {
  console.error("usage: npm run voices -- <cartesia|elevenlabs>");
  process.exit(1);
}

const voices = await getTts(provider, loadEnv()).listVoices();
for (const v of voices) console.log(`${v.id}  ${v.name}${v.description ? ` — ${v.description.slice(0, 80)}` : ""}`);
process.exit(0);
