// bot.js - SFX synth version (no MP3 files)
require("dotenv").config();

const express = require("express");
const { Readable } = require("stream");
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
  VoiceConnectionStatus,
  StreamType
} = require("@discordjs/voice");

const prism = require("prism-media");

/* -------------------- Express keep-alive (Render Web Service) -------------------- */
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("OK - Discord Timer Bot (SFX)"));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

/* --------------------------------- Discord bot ---------------------------------- */
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

/* --------------------------- Slash command: /timer ------------------------------- */
/* Thêm lựa chọn "effect": beep | double | triple */
const commands = [
  new SlashCommandBuilder()
    .setName("timer")
    .setDescription("Đặt hẹn giờ (đơn vị: phút)")
    .addIntegerOption(o =>
      o.setName("minutes")
        .setDescription("Số phút hẹn (1–150)")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(150)
    )
    .addStringOption(o =>
      o.setName("effect")
        .setDescription("Hiệu ứng âm thanh khi hết giờ")
        .addChoices(
          { name: "beep (mặc định)", value: "beep" },
          { name: "double", value: "double" },
          { name: "triple", value: "triple" }
        )
        .setRequired(false)
    )
    .addRoleOption(o =>
      o.setName("role")
        .setDescription("Role sẽ được mention khi hết giờ")
        .setRequired(false)
    )
].map(c => c.toJSON());

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

/* ------------------------- SFX synth helpers (no files) -------------------------- */
/**
 * Tạo Readable stream sinh PCM 16-bit LE stereo 48kHz theo kịch bản segments.
 * segments: [{ type:'tone'|'silence', ms:number, freq?:number, volume?:0..1, envelope?:'none'|'decay'}]
 */
function makePCMStream(segments) {
  const sampleRate = 48000;
  const channels = 2;
  const bytesPerSample = 2; // 16-bit
  const frameMs = 20;
  const samplesPerFrame = (sampleRate / 1000) * frameMs; // 960
  let segIndex = 0;
  let segOffsetSamples = 0;

  return new Readable({
    read() {
      if (segIndex >= segments.length) return this.push(null);

      const seg = segments[segIndex];
      const segTotalSamples = Math.round((seg.ms / 1000) * sampleRate);

      const samplesToWrite = Math.min(samplesPerFrame, segTotalSamples - segOffsetSamples);
      if (samplesToWrite <= 0) {
        segIndex++;
        segOffsetSamples = 0;
        return this.read();
      }

      const buf = Buffer.alloc(samplesToWrite * channels * bytesPerSample);
      const freq = seg.freq ?? 880;
      const vol = Math.max(0, Math.min(1, seg.volume ?? 0.6));

      for (let i = 0; i < samplesToWrite; i++) {
        const t = (segOffsetSamples + i) / sampleRate;

        let sample = 0;
        if (seg.type === "tone") {
          // sine
          let amplitude = vol;
          if (seg.envelope === "decay") {
            const remain = segTotalSamples - (segOffsetSamples + i);
            const decay = Math.max(0.05, remain / segTotalSamples);
            amplitude *= decay;
          }
          sample = Math.sin(2 * Math.PI * freq * t) * 32767 * amplitude;
        } else {
          // silence
          sample = 0;
        }

        const s = Math.max(-32767, Math.min(32767, sample)) | 0;
        // stereo (copy L=R)
        buf.writeInt16LE(s, (i * channels + 0) * bytesPerSample);
        buf.writeInt16LE(s, (i * channels + 1) * bytesPerSample);
      }

      segOffsetSamples += samplesToWrite;
      this.push(buf);
    }
  });
}

/** Presets: beep/double/triple */
function buildEffect(effect = "beep") {
  switch (effect) {
    case "double":
      return [
        { type: "tone", ms: 300, freq: 880, volume: 0.8 },
        { type: "silence", ms: 150 },
        { type: "tone", ms: 300, freq: 990, volume: 0.8 }
      ];
    case "triple":
      return [
        { type: "tone", ms: 250, freq: 880, volume: 0.8 },
        { type: "silence", ms: 120 },
        { type: "tone", ms: 250, freq: 880, volume: 0.8 },
        { type: "silence", ms: 120 },
        { type: "tone", ms: 350, freq: 1200, volume: 0.8, envelope: "decay" }
      ];
    case "beep":
    default:
      return [{ type: "tone", ms: 600, freq: 880, volume: 0.85, envelope: "decay" }];
  }
}

/** Trả về stream Opus từ preset effect */
function makeOpusFromEffect(effect) {
  const pcm = makePCMStream(buildEffect(effect));
  const encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  return pcm.pipe(encoder);
}

/* --------------------------------- Handlers ------------------------------------- */
client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "timer") return;

  const minutes = interaction.options.getInteger("minutes");
  const effect = interaction.options.getString("effect") || "beep";
  const pickedRole = interaction.options.getRole("role");
  const voiceChannel = interaction.member?.voice?.channel;

  if (!voiceChannel) {
    await interaction.reply("❌ Bạn cần vào voice channel trước!");
    return;
  }

  await interaction.reply(
    `⏳ Đã đặt hẹn **${minutes} phút** với hiệu ứng **${effect}**.${
      pickedRole ? ` Sẽ ping <@&${pickedRole.id}> khi hết giờ.` : ""
    }`
  );

  const delayMs = minutes * 60 * 1000;

  setTimeout(() => {
    const job = async () => {
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
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

        const player = createAudioPlayer();
        const opusStream = makeOpusFromEffect(effect);
        const resource = createAudioResource(opusStream, { inputType: StreamType.Opus });

        connection.subscribe(player);
        player.play(resource);

        // Ping khi hết giờ
        if (pickedRole) {
          await interaction.followUp({
            content: `⏰ Hết giờ! Ping <@&${pickedRole.id}>`,
            allowedMentions: { roles: [pickedRole.id] }
          });
        } else {
          await interaction.followUp("⏰ Hết giờ!");
        }

        // Auto out tối đa sau 30s
        const forceLeave = setTimeout(() => {
          try { connection.destroy(); } catch {}
        }, 30_000);

        player.on(AudioPlayerStatus.Playing, () => {
          console.log(`🎵 PLAYING SFX: ${effect}`);
        });

        await new Promise(resolve => {
          player.on(AudioPlayerStatus.Idle, () => {
            clearTimeout(forceLeave);
            try { connection.destroy(); } catch {}
            resolve();
          });
          player.on("error", err => {
            console.error("❌ Audio player error:", err);
            clearTimeout(forceLeave);
            try { connection.destroy(); } catch {}
            resolve();
          });
        });
      } catch (err) {
        console.error("❌ Join/Ready/Play error:", err);
        try { connection.destroy(); } catch {}
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
