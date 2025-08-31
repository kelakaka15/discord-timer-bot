require("dotenv").config();

const express = require("express");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus
} = require("@discordjs/voice");

// --- Express keep-alive cho Render Web Service ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("OK - Discord Timer Bot"));
app.listen(PORT, () => {
  console.log(`Express server listening on port ${PORT}`);
});

// --- Discord client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing env: TOKEN / CLIENT_ID / GUILD_ID");
  process.exit(1);
}

// --- Slash commands: /timer minutes(1-150) role(optional) ---
const commands = [
  new SlashCommandBuilder()
    .setName("timer")
    .setDescription("Đặt hẹn giờ (đơn vị: phút)")
    .addIntegerOption(o =>
      o
        .setName("minutes")
        .setDescription("Số phút hẹn (1–150)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(150)
    )
    .addRoleOption(o =>
      o
        .setName("role")
        .setDescription("Role sẽ được mention khi hết giờ")
        .setRequired(false)
    )
].map(c => c.toJSON());

// --- Đăng ký lệnh (guild-scoped cho nhanh) ---
const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands
    });
    console.log("✅ Slash command registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

// --- Hàng đợi theo guild để chống va chạm khi nhiều timer nổ cùng lúc ---
const guildQueues = new Map(); // guildId -> array<() => Promise<void>>

function addToQueue(guildId, job) {
  const q = guildQueues.get(guildId) || [];
  q.push(job);
  guildQueues.set(guildId, q);
  if (q.length === 1) runNext(guildId);
}

async function runNext(guildId) {
  const q = guildQueues.get(guildId);
  if (!q || q.length === 0) return;
  try {
    await q[0]();
  } finally {
    q.shift();
    if (q.length) runNext(guildId);
  }
}

client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "timer") return;

  const minutes = interaction.options.getInteger("minutes");
  const pickedRole = interaction.options.getRole("role"); // optional
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply("❌ Bạn cần vào voice channel trước!");
    return;
  }

  await interaction.reply(
    `⏳ Đã đặt hẹn **${minutes} phút**.${
      pickedRole ? ` Sẽ ping <@&${pickedRole.id}> khi hết giờ.` : ""
    }`
  );

  const delayMs = minutes * 60 * 1000;

  setTimeout(() => {
    const job = async () => {
      // Tại thời điểm nổ timer, người gọi có thể đã rời kênh
      const channelNow = interaction.guild.channels.cache.get(voiceChannel.id);
      if (!channelNow) {
        await interaction.followUp("⚠️ Voice channel không còn tồn tại.");
        return;
      }

      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator
      });

      try {
        // Chờ sẵn sàng
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

        const player = createAudioPlayer();
        const filePath = path.join(__dirname, "sound.mp3");
        const resource = createAudioResource(filePath);

        connection.subscribe(player);
        player.play(resource);

        // Gửi ping khi hết giờ (ngay khi bắt đầu phát)
        if (pickedRole) {
          await interaction.followUp({
            content: `⏰ Hết giờ! Ping <@&${pickedRole.id}>`,
            allowedMentions: { roles: [pickedRole.id] }
          });
        } else {
          await interaction.followUp("⏰ Hết giờ!");
        }

        // Tự out tối đa sau 30s kể từ bắt đầu phát
        const forceLeave = setTimeout(() => {
          try {
            connection.destroy();
          } catch {}
        }, 30_000);

        player.on(AudioPlayerStatus.Playing, () => {
          console.log("🎵 Đang phát:", filePath);
        });

        await new Promise(resolve => {
          player.on(AudioPlayerStatus.Idle, () => {
            clearTimeout(forceLeave);
            try {
              connection.destroy();
            } catch {}
            resolve();
          });
          player.on("error", err => {
            console.error("❌ Audio player error:", err);
            clearTimeout(forceLeave);
            try {
              connection.destroy();
            } catch {}
            resolve();
          });
        });
      } catch (err) {
        console.error("❌ Join/Ready/Play error:", err);
        try {
          connection.destroy();
        } catch {}
        await interaction.followUp("⚠️ Có lỗi khi vào voice hoặc phát âm thanh.");
      }
    };

    addToQueue(voiceChannel.guild.id, job);
  }, delayMs);
});

client.login(TOKEN).catch(err => {
  console.error("Login failed:", err);
  process.exit(1);
});
