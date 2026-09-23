import "dotenv/config";
import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";

/** Print the servers the bot is in and their voice channels, to fill in .env. */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (c) => {
  console.log(`bot: ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) {
    console.log(`\nserver "${guild.name}"  DISCORD_GUILD_ID=${guild.id}`);
    const channels = await guild.channels.fetch();
    for (const ch of channels.values()) {
      if (ch?.type === ChannelType.GuildVoice) console.log(`  voice "${ch.name}"  DISCORD_VOICE_CHANNEL_ID=${ch.id}`);
    }
  }
  await c.destroy();
});

client.login(process.env.DISCORD_TOKEN);
