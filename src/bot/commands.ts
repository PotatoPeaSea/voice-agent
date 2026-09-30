import { ChannelType, SlashCommandBuilder } from "discord.js";

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
].map((c) => c.toJSON());
