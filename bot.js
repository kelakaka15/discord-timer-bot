require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require("@discordjs/voice");

const app = express();
const PORT = process.env.PORT || 3000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing one of environment variables: TOKEN, CLIENT_ID, GUILD_ID");
  process.exit(1);
}

// Health endpoint (Render dùng để check)
app.get("/", (req, res) => res.send("OK - Discord Timer Bot"));

app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
});

// Register slash command
const commands = [
  new SlashCommandBuilder()
    .setName("timer")
    .setDescription("Đặt hẹn giờ phát âm thanh")
    .addIntegerOption(option =>
      option.setName("seconds")
            .setDescription("Thời gian hẹn (giây)")
            .setRequired(true)
    )
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Slash command registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "timer") return;

  const seconds = interaction.options.getInteger("seconds");
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    await interaction.reply("❌ Bạn cần vào voice channel trước!");
    return;
  }

  await interaction.reply(`⏳ Đã đặt hẹn giờ ${seconds} giây. Mình sẽ vào voice khi xong nhé!`);

  setTimeout(async () => {
    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator
      });

      const player = createAudioPlayer();
      const resource = createAudioResource("sound.mp3");

      connection.subscribe(player);
      player.play(resource);

      player.on(AudioPlayerStatus.Idle, () => {
        try { connection.destroy(); } catch(e){ /* ignore */ }
      });

      player.on("error", err => {
        console.error("Audio player error:", err);
        try { connection.destroy(); } catch(e){ /* ignore */ }
      });
    } catch (err) {
      console.error("Error joining voice / playing audio:", err);
    }
  }, Math.max(0, seconds) * 1000);
});

client.login(TOKEN).catch(err => {
  console.error("Login failed:", err);
  process.exit(1);
});
