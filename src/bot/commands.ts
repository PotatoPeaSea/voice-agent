import { ChannelType, SlashCommandBuilder } from "discord.js";
import { SYSTEM_PROMPT_DESCRIPTIONS, SYSTEM_PROMPT_NAMES } from "../orchestrator/prompt.js";
import { VOICE_COMMAND } from "./voice-command.js";

/** Guild slash commands (registered on startup; guild commands update instantly). */
export const COMMANDS = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join a voice channel (default: the one you're in)")
    .addChannelOption((o) =>
      o.setName("channel").setDescription("Voice channel to join").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
    ),
  new SlashCommandBuilder().setName("leave").setDescription("Leave the voice channel (the bot stays online and tasks keep running)"),
  new SlashCommandBuilder().setName("newchat").setDescription("Start a fresh conversation with the bot (tasks keep running)"),
  new SlashCommandBuilder()
    .setName("prompt")
    .setDescription("Switch the bot's system prompt (persona), or show the current one")
    .addStringOption((o) =>
      o
        .setName("name")
        .setDescription("System prompt to use")
        .addChoices(...SYSTEM_PROMPT_NAMES.map((n) => ({ name: `${n}: ${SYSTEM_PROMPT_DESCRIPTIONS[n]}`, value: n }))),
    ),
].map((c) => c.toJSON())
  .concat(VOICE_COMMAND);
