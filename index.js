const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType
} = require('@discordjs/voice');
require('dotenv').config();
const { spawn } = require('child_process');
const { Readable } = require('stream');

// Check and force the use of opusscript
try {
    require('opusscript');
    console.log('✅ Opus encoder (opusscript) chargé avec succès');
} catch {
    console.error('❌ Opusscript introuvable. Installe-le avec : npm install opusscript');
    process.exit(1);
}

// Environment variables validation
const TOKEN = process.env.DISCORD_TOKEN;
const RADIO_URL = process.env.RADIO_URL;

if (!TOKEN) {
    console.error('❌ DISCORD_TOKEN manquant dans les variables d\'environnement');
    console.error('💡 Assure-toi de définir DISCORD_TOKEN dans ton fichier .env ou les variables Docker');
    process.exit(1);
}

if (!RADIO_URL) {
    console.error('❌ RADIO_URL manquant dans les variables d\'environnement');
    console.error('💡 Assure-toi de définir RADIO_URL dans ton fichier .env ou les variables Docker');
    process.exit(1);
}

console.log('✅ Variables d\'environnement chargées');
console.log(`📻 Radio URL configurée: ${RADIO_URL}`);
console.log(`🤖 Bot token configuré: ${TOKEN.substring(0, 20)}...`);

function checkFFmpeg() {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', ['-version']);

        ffmpeg.on('error', () => resolve(false));
        ffmpeg.on('close', (code) => resolve(code === 0));
    });
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const connections = new Map();
const players = new Map();
const reconnectTimers = new Map();

client.once('ready', async () => {
    console.log(`${client.user.tag} est connecté et prêt !`);
    console.log(`🏗️ Architecture: ${process.arch}`);
    console.log(`💻 Plateforme: ${process.platform}`);
    console.log(`🔄 Mode: Connexion permanente (24/7)`);

    const ffmpegOk = await checkFFmpeg();
    if (!ffmpegOk) {
        console.error('❌ FFmpeg non fonctionnel ou absent.');
        process.exit(1);
    }
    console.log('✅ FFmpeg détecté et fonctionnel');

    const commands = [
        new SlashCommandBuilder().setName('play').setDescription('Lancer la radio'),
        new SlashCommandBuilder().setName('stop').setDescription('Arrêter la radio'),
        new SlashCommandBuilder().setName('disconnect').setDescription('Déconnecter le bot'),
        new SlashCommandBuilder().setName('volume').setDescription('Changer le volume')
            .addIntegerOption(option =>
                option.setName('level').setDescription('Niveau (1-100)').setRequired(true).setMinValue(1).setMaxValue(100)
            ),
        new SlashCommandBuilder().setName('info').setDescription('Infos système')
    ];

    try {
        await client.application.commands.set(commands);
        console.log('✅ Commandes slash enregistrées');
    } catch (err) {
        console.error('❌ Erreur d’enregistrement des commandes:', err);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        switch (commandName) {
            case 'play': return await handlePlay(interaction);
            case 'stop': return await handleStop(interaction);
            case 'disconnect': return await handleDisconnect(interaction);
            case 'volume': return await handleVolume(interaction);
            case 'info': return await handleInfo(interaction);
        }
    } catch (err) {
        console.error('❌ Erreur commande:', err);
        if (!interaction.replied) {
            await interaction.reply({ content: '❌ Erreur pendant la commande.', ephemeral: true });
        }
    }
});

async function createRadioResource(url, guildId) {
    try {
        const ffmpeg = spawn('ffmpeg', [
            '-i', url,
            '-analyzeduration', '0',
            '-loglevel', '0',
            '-f', 's16le',
            '-ar', '48000',
            '-ac', '2',
            'pipe:1'
        ]);

        const stream = Readable.from(ffmpeg.stdout);

        const resource = createAudioResource(stream, {
            inputType: StreamType.Raw,
            inlineVolume: true,
            metadata: { title: 'WebRadio 24/7' }
        });

        if (resource.volume) {
            resource.volume.setVolume(0.5);
        }

        return resource;
    } catch (error) {
        console.error('❌ Erreur ressource FFmpeg:', error);
        scheduleReconnect(guildId);
        throw error;
    }
}

function scheduleReconnect(guildId, delay = 10000) {
    if (reconnectTimers.has(guildId)) clearTimeout(reconnectTimers.get(guildId));

    const timer = setTimeout(async () => {
        const conn = connections.get(guildId);
        const player = players.get(guildId);
        if (conn && player) {
            try {
                const resource = await createRadioResource(RADIO_URL, guildId);
                player.play(resource);
                console.log(`✅ Reconnexion réussie pour ${guildId}`);
            } catch (err) {
                console.error(`❌ Échec de reconnexion pour ${guildId}:`, err);
                scheduleReconnect(guildId, Math.min(delay * 2, 60000));
            }
        }
        reconnectTimers.delete(guildId);
    }, delay);

    reconnectTimers.set(guildId, timer);
}

async function handlePlay(interaction) {
    const voiceChannel = interaction.member.voice.channel;
    const guildId = interaction.guildId;

    if (!voiceChannel) {
        return interaction.reply({ content: '❌ Rejoins un salon vocal d’abord !', ephemeral: true });
    }

    await interaction.deferReply();

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator
    });

    const player = createAudioPlayer();
    const resource = await createRadioResource(RADIO_URL, guildId);

    player.play(resource);
    connection.subscribe(player);

    players.set(guildId, player);
    connections.set(guildId, connection);

    player.on(AudioPlayerStatus.Idle, () => {
        console.log('⏳ Inactif, tentative de reconnexion...');
        scheduleReconnect(guildId);
    });

    player.on('error', err => {
        console.error('❌ Erreur lecteur:', err);
        scheduleReconnect(guildId);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log('🔌 Déconnecté, tentative de reconnexion...');
        scheduleReconnect(guildId);
    });

    await interaction.editReply(`🎶 Radio lancée dans **${voiceChannel.name}** en 24/7`);
}

async function handleStop(interaction) {
    const player = players.get(interaction.guildId);
    if (player) player.stop();
    if (reconnectTimers.has(interaction.guildId)) {
        clearTimeout(reconnectTimers.get(interaction.guildId));
        reconnectTimers.delete(interaction.guildId);
    }
    await interaction.reply('⏹️ Radio arrêtée (bot reste connecté)');
}

async function handleDisconnect(interaction) {
    const conn = connections.get(interaction.guildId);
    const player = players.get(interaction.guildId);
    if (player) player.stop();
    if (conn) conn.destroy();

    reconnectTimers.delete(interaction.guildId);
    connections.delete(interaction.guildId);
    players.delete(interaction.guildId);

    await interaction.reply('🔌 Déconnecté du vocal');
}

async function handleVolume(interaction) {
    const volume = interaction.options.getInteger('level');
    const player = players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ Aucun stream en cours.', ephemeral: true });

    const resource = player.state.resource;
    if (resource?.volume) {
        resource.volume.setVolume(volume / 100);
        await interaction.reply(`🔊 Volume réglé à ${volume}%`);
    } else {
        await interaction.reply({ content: '❌ Volume non disponible.', ephemeral: true });
    }
}

async function handleInfo(interaction) {
    const os = require('os');

    const embed = new EmbedBuilder()
        .setTitle('ℹ️ Infos du bot')
        .addFields(
            { name: '📻 Radio URL', value: RADIO_URL || 'Non configurée' },
            { name: '🖥️ OS', value: `${os.type()} ${os.release()}` },
            { name: '🏗️ Archi', value: process.arch },
            { name: '🟢 Node.js', value: process.version },
            { name: '🎚️ FFmpeg', value: 'Via spawn / Raw PCM' },
            { name: '🔊 Opus', value: 'opusscript' }
        )
        .setColor(0x00ff00)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

client.login(TOKEN);
