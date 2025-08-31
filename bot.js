require("dotenv").config();

const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require("discord.js");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require("@discordjs/voice");

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// Đăng ký slash command
const commands = [
    new SlashCommandBuilder()
        .setName("timer")
        .setDescription("Đặt hẹn giờ phát âm thanh")
        .addIntegerOption(option =>
            option.setName("seconds")
                .setDescription("Thời gian hẹn (giây)")
                .setRequired(true)
        )
].map(cmd => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(TOKEN);

(async () => {
    try {
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands },
        );
        console.log("✅ Slash command đã đăng ký");
    } catch (err) {
        console.error(err);
    }
})();

client.once("ready", () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
});

client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "timer") {
        const seconds = interaction.options.getInteger("seconds");
        const voiceChannel = interaction.member.voice.channel;

        if (!voiceChannel) {
            await interaction.reply("❌ Bạn cần vào voice channel trước!");
            return;
        }

        await interaction.reply(`⏳ Đã đặt hẹn giờ ${seconds} giây. Chờ nhé!`);

        setTimeout(() => {
            try {
                const connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                });

                const player = createAudioPlayer();
                const resource = createAudioResource("sound.mp3");

                connection.subscribe(player);
                player.play(resource);

                player.on(AudioPlayerStatus.Idle, () => {
                    connection.destroy();
                });

            } catch (err) {
                console.error(err);
            }
        }, seconds * 1000);
    }
});

client.login(TOKEN);
