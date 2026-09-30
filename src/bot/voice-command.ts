import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Env } from "../config.js";
import { resolveVoice } from "../speech/index.js";
import { setActiveVoice, type VoiceConfig } from "../speech/voices.js";

/** `/voice [name]`: switch the speaking voice (saved to config/voices.yaml), or list voices. */
export const VOICE_COMMAND = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("Switch the bot's speaking voice, or list the voices")
  .addStringOption((o) =>
    o.setName("name").setDescription("Voice profile from config/voices.yaml").setAutocomplete(true),
  )
  .toJSON();

export interface VoiceCommandDeps {
  voices: VoiceConfig;
  env: Env;
  /** Say a line in the (new) current voice, if the bot is in a channel and not busy talking. */
  preview: (text: string) => void;
  log: (...a: unknown[]) => void;
}

function describe(voices: VoiceConfig, name: string): string {
  const p = voices.profiles[name];
  return `**${name}** (${p.provider}: ${p.voiceId})`;
}

export async function voiceAutocomplete(interaction: AutocompleteInteraction, { voices }: VoiceCommandDeps): Promise<void> {
  const typed = interaction.options.getFocused().toLowerCase();
  const choices = Object.keys(voices.profiles)
    .filter((name) => name.toLowerCase().includes(typed))
    .slice(0, 25) // Discord's limit
    .map((name) => ({ name: name === voices.active ? `${name} (current)` : name, value: name }));
  await interaction.respond(choices);
}

/** Handles /voice. The caller checks the user is allowed. */
export async function voiceCommand(interaction: ChatInputCommandInteraction, deps: VoiceCommandDeps): Promise<void> {
  const { voices, env, log } = deps;
  const name = interaction.options.getString("name");
  if (!name) {
    const list = Object.keys(voices.profiles)
      .map((n) => `${n === voices.active ? "▶" : "•"} ${describe(voices, n)}`)
      .join("\n");
    await interaction.reply({ content: `Voices (switch with \`/voice name:<voice>\`):\n${list}`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!voices.profiles[name]) {
    await interaction.reply({
      content: `No voice called "${name}". Available: ${Object.keys(voices.profiles).join(", ")}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Build the provider now so a missing API key fails here, not on the next reply.
  let tts: { connect?: () => Promise<unknown> };
  try {
    tts = resolveVoice(voices, name, env).primary.tts as typeof tts;
  } catch (err) {
    await interaction.reply({ content: `Can't use ${describe(voices, name)}: ${(err as Error).message}`, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  await tts.connect?.().catch((e: Error) => log("tts connect failed:", e.message));
  setActiveVoice(voices, name);
  log(`voice switched to ${name} by ${interaction.user.tag}`);
  await interaction.editReply(`Voice switched to ${describe(voices, name)}.`);
  deps.preview("Okay, this is my new voice.");
}
