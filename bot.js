// bot.js - Soundboard only + Autocomplete for "sound"
require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
} = require("discord.js");
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  AudioPlayerStatus,
} = require("@discordjs/voice");

/* -------------------- Express keep-alive (Render Web Service) -------------------- */
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("OK - Discord Timer Bot (Soundboard + Autocomplete)"));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

/* --------------------------------- Discord bot ---------------------------------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("Missing env: TOKEN / CLIENT_ID / GUILD_ID");
  process.exit(1);
}

/* --------------------------- Slash command: /timer ------------------------------- */
/* Lưu ý: dùng autocomplete => KHÔNG dùng addChoices */
const commands = [
  new SlashCommandBuilder()
    .setName("timer")
    .setDescription("Đặt hẹn giờ (đơn vị: phút) và phát Soundboard")
    .addIntegerOption((o) =>
      o
        .setName("minutes")
        .setDescription("Số phút hẹn (1–150)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(150)
    )
    .addStringOption((o) =>
      o
        .setName("sound")
        .setDescription("Tên soundboard trong server (có autocomplete)")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addRoleOption((o) =>
      o
        .setName("role")
        .setDescription("Role sẽ được mention khi hết giờ")
        .setRequired(false)
    ),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);
(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log("✅ Slash command registered.");
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
})();

/* -------------------------- Per-guild playback queue ----------------------------- */
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

/* -------------------------- Soundboard list cache (2 phút) ----------------------- */
const SOUND_CACHE_TTL = 2 * 60 * 1000;
const soundCache = new Map(); // guildId -> { fetchedAt, items }

async function fetchGuildSounds(guildId) {
  const now = Date.now();
  const cached = soundCache.get(guildId);
  if (cached && now - cached.fetchedAt < SOUND_CACHE_TTL) {
    return cached.items;
  }
  // API lấy danh sách soundboard của guild
  const res = await rest.get(Routes.guildSoundboardSounds(guildId));
  const items = Array.isArray(res) ? res : res?.items || [];
  soundCache.set(guildId, { fetchedAt: now, items });
  return items;
}

/* --------------------------------- Handlers ------------------------------------- */
client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  /* ---------- Autocomplete cho option "sound" ---------- */
  if (interaction.isAutocomplete()) {
    try {
      if (interaction.commandName === "timer") {
        const focused = interaction.options.getFocused(true); // { name, value }
        if (focused.name === "sound") {
          const query = (focused.value || "").toLowerCase();
          const list = await fetchGuildSounds(interaction.guildId).catch(() => []);
          const suggestions = list
            .filter((s) => s?.name && s.name.toLowerCase().includes(query))
            .slice(0, 25)
            .map((s) => ({ name: s.name, value: s.name }));
          await interaction.respond(suggestions.length ? suggestions : [{ name: "Không tìm thấy sound", value: query.slice(0, 100) }]);
        }
      }
    } catch (e) {
      // Nếu lỗi, trả rỗng để tránh báo đỏ cho user
      try { await interaction.respond([]); } catch {}
    }
    return;
  }

  /* ---------- Xử lý slash command ---------- */
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "timer") return;

  const minutes = interaction.options.getInteger("minutes");
  const soundName = interaction.options.getString("sound");
  const pickedRole = interaction.options.getRole("role");
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply("❌ Bạn cần vào voice channel trước!");
    return;
  }

  // Tìm sound theo tên ngay trước khi phát (đảm bảo còn tồn tại)
  let sounds;
  try {
    sounds = await fetchGuildSounds(voiceChannel.guild.id);
  } catch (e) {
    console.error("Fetch guild soundboard sounds error:", e);
    await interaction.reply("⚠️ Không lấy được danh sách soundboard trong server.");
    return;
  }

  const target = sounds.find((s) => s.name?.toLowerCase() === soundName.toLowerCase());
  if (!target) {
    await interaction.reply(`❌ Không tìm thấy soundboard tên **${soundName}** trong server.`);
    return;
  }

  await interaction.reply(
    `⏳ Đã đặt hẹn **${minutes} phút**. Sẽ phát soundboard **${target.name}** khi hết giờ.${
      pickedRole ? ` (Ping <@&${pickedRole.id}>)` : ""
    }`
  );

  const delayMs = minutes * 60 * 1000;

  setTimeout(() => {
    const job = async () => {
      // Kiểm tra kênh còn tồn tại
      const channelNow = interaction.guild.channels.cache.get(voiceChannel.id);
      if (!channelNow) {
        await interaction.followUp("⚠️ Voice channel không còn tồn tại.");
        return;
      }

      // Join VC (yêu cầu đang kết nối để gửi soundboard)
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

        // Gửi soundboard sound qua REST
        try {
          await rest.post(Routes.sendSoundboardSound(voiceChannel.id), {
            body: {
              sound_id: target.sound_id,
              // Nếu sound thuộc guild khác cần source_guild_id:
              // source_guild_id: target.guild_id !== voiceChannel.guild.id ? target.guild_id : undefined,
            },
          });
        } catch (e) {
          console.error("Send soundboard error:", e);
          await interaction.followUp("⚠️ Không thể phát soundboard (thiếu quyền hoặc ràng buộc khác).");
        }

        // Ping role (nếu có)
        if (pickedRole) {
          await interaction.followUp({
            content: `⏰ Hết giờ! Ping <@&${pickedRole.id}>`,
            allowedMentions: { roles: [pickedRole.id] },
          });
        } else {
          await interaction.followUp("⏰ Hết giờ!");
        }

        // Auto rời tối đa sau 30s
        const forceLeave = setTimeout(() => {
          try { connection.destroy(); } catch {}
        }, 30_000);

        // Player chỉ để đồng bộ thời gian rời (không phát audio riêng)
        const player = createAudioPlayer();
        connection.subscribe(player);
        player.on(AudioPlayerStatus.Idle, () => { /* no-op */ });

        // Đợi 3s rồi rời (hoàn tất)
        setTimeout(() => {
          clearTimeout(forceLeave);
          try { connection.destroy(); } catch {}
        }, 3000);
      } catch (err) {
        console.error("Join/Ready error:", err);
        try { connection.destroy(); } catch {}
        await interaction.followUp("⚠️ Có lỗi khi vào voice để phát soundboard.");
      }
    };

    addToQueue(voiceChannel.guild.id, job);
  }, delayMs);
});

client.login(TOKEN).catch((err) => {
  console.error("Login failed:", err);
  process.exit(1);
});
