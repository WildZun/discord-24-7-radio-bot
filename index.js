const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
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
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

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
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'radio-bot.sqlite');

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

fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
    CREATE TABLE IF NOT EXISTS radio_sessions (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL
    )
`);

const getSessions = database.prepare('SELECT guild_id, channel_id FROM radio_sessions');
const saveSession = database.prepare(`
    INSERT INTO radio_sessions (guild_id, channel_id) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
`);
const deleteSession = database.prepare('DELETE FROM radio_sessions WHERE guild_id = ?');

function checkFFmpeg() {
    return new Promise((resolve) => {
        const ffmpeg = spawn(ffmpegPath, ['-version']);

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
const ffmpegProcesses = new Map();
const activeStreams = new Set();
const notificationChannels = new Map();
const lastErrorNotices = new Map();

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

    await restoreSessions();
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
        if (interaction.deferred) {
            await interaction.editReply('❌ Impossible de lancer ou gérer ce flux radio. Consulte les logs du bot.');
        } else if (!interaction.replied) {
            await interaction.reply({ content: '❌ Erreur pendant la commande.', flags: MessageFlags.Ephemeral });
        }
    }
});

function stopFFmpeg(guildId) {
    const ffmpeg = ffmpegProcesses.get(guildId);
    ffmpegProcesses.delete(guildId);

    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill();
}

function reportStreamError(guildId, error) {
    console.error(`❌ Erreur flux radio pour ${guildId}:`, error);

    const now = Date.now();
    if (now - (lastErrorNotices.get(guildId) || 0) < 60000) return;
    lastErrorNotices.set(guildId, now);

    const channel = notificationChannels.get(guildId);
    if (channel?.isTextBased()) {
        channel.send('⚠️ Flux radio interrompu. Reconnexion automatique en cours.').catch(err => {
            console.error(`❌ Impossible d’envoyer erreur flux pour ${guildId}:`, err);
        });
    }
}

function stopStream(guildId, disconnect = false) {
    activeStreams.delete(guildId);
    lastErrorNotices.delete(guildId);
    stopFFmpeg(guildId);

    const timer = reconnectTimers.get(guildId);
    if (timer) clearTimeout(timer);
    reconnectTimers.delete(guildId);

    const player = players.get(guildId);
    if (player) player.stop();
    players.delete(guildId);

    if (disconnect) {
        const connection = connections.get(guildId);
        if (connection) connection.destroy();
        connections.delete(guildId);
        notificationChannels.delete(guildId);
    }
}

function createVoiceSession(guildId, channelId, adapterCreator) {
    const connection = joinVoiceChannel({ channelId, guildId, adapterCreator });
    const player = createAudioPlayer();
    connection.subscribe(player);

    players.set(guildId, player);
    connections.set(guildId, connection);

    player.on(AudioPlayerStatus.Idle, () => {
        console.log('⏳ Inactif, tentative de reconnexion...');
        scheduleReconnect(guildId);
    });

    player.on('error', err => {
        console.error('❌ Erreur lecteur:', err);
        if (activeStreams.has(guildId)) reportStreamError(guildId, err);
        scheduleReconnect(guildId);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
        console.log('🔌 Déconnecté, tentative de reconnexion...');
        if (activeStreams.has(guildId)) reportStreamError(guildId, new Error('Connexion vocale Discord interrompue'));
        scheduleReconnect(guildId);
    });
}

async function restoreSessions() {
    for (const { guild_id: guildId, channel_id: channelId } of getSessions.all()) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            console.error(`❌ Guild sauvegardée inaccessible: ${guildId}`);
            continue;
        }

        try {
            const channel = await guild.channels.fetch(channelId);
            if (!channel?.isVoiceBased()) {
                deleteSession.run(guildId);
                console.error(`❌ Salon vocal sauvegardé introuvable: ${guildId}/${channelId}`);
                continue;
            }

            activeStreams.add(guildId);
            createVoiceSession(guildId, channel.id, guild.voiceAdapterCreator);
            startPlayback(guildId);
            console.log(`✅ Session restaurée pour ${guildId}`);
        } catch (err) {
            stopStream(guildId, true);
            console.error(`❌ Échec restauration session ${guildId}:`, err);
        }
    }
}

function hasHumanListeners(guildId) {
    const connection = connections.get(guildId);
    const channelId = connection?.joinConfig.channelId;
    const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);

    return channel?.isVoiceBased() && channel.members.some(member => !member.user.bot);
}

function pauseStream(guildId) {
    stopFFmpeg(guildId);
    const player = players.get(guildId);
    if (player) player.stop(true);
    console.log(`⏸️ Flux suspendu pour ${guildId}: salon vocal vide`);
}

function createRadioResource(url, guildId) {
    stopFFmpeg(guildId);

    const ffmpeg = spawn(ffmpegPath, [
        '-i', url,
        '-analyzeduration', '0',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpegProcesses.set(guildId, ffmpeg);

    let stderr = '';
    ffmpeg.stderr.on('data', chunk => {
        stderr = `${stderr}${chunk}`.slice(-2000);
    });

    const handleFailure = error => {
        if (ffmpegProcesses.get(guildId) !== ffmpeg) return;
        ffmpegProcesses.delete(guildId);
        if (!ffmpeg.killed) ffmpeg.kill();
        reportStreamError(guildId, stderr ? `${error.message}\n${stderr.trim()}` : error);
        scheduleReconnect(guildId);
    };

    ffmpeg.on('error', handleFailure);
    ffmpeg.stdout.on('error', handleFailure);
    ffmpeg.stderr.on('error', handleFailure);
    ffmpeg.on('close', (code, signal) => {
        if (ffmpegProcesses.get(guildId) !== ffmpeg) return;

        if (signal) {
            handleFailure(new Error(`FFmpeg arrêté par signal ${signal}`));
        } else if (code !== 0) {
            handleFailure(new Error(`FFmpeg arrêté avec code ${code}`));
        } else if (activeStreams.has(guildId)) {
            handleFailure(new Error('FFmpeg a arrêté le flux de façon inattendue'));
        }
    });

    const resource = createAudioResource(ffmpeg.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
        metadata: { title: 'WebRadio 24/7' }
    });

    if (resource.volume) resource.volume.setVolume(0.5);

    return resource;
}

function startPlayback(guildId) {
    if (!activeStreams.has(guildId) || !hasHumanListeners(guildId)) return;

    const player = players.get(guildId);
    if (!player || player.state.status !== AudioPlayerStatus.Idle) return;

    const resource = createRadioResource(RADIO_URL, guildId);
    player.play(resource);
    console.log(`▶️ Flux lancé pour ${guildId}`);
}

function scheduleReconnect(guildId, delay = 10000) {
    if (!activeStreams.has(guildId) || !hasHumanListeners(guildId)) return;
    if (reconnectTimers.has(guildId)) clearTimeout(reconnectTimers.get(guildId));

    const timer = setTimeout(async () => {
        if (reconnectTimers.get(guildId) !== timer) return;
        reconnectTimers.delete(guildId);

        if (!activeStreams.has(guildId) || !hasHumanListeners(guildId)) return;
        if (players.has(guildId)) {
            try {
                startPlayback(guildId);
                console.log(`✅ Reconnexion réussie pour ${guildId}`);
            } catch (err) {
                console.error(`❌ Échec de reconnexion pour ${guildId}:`, err);
                scheduleReconnect(guildId, Math.min(delay * 2, 60000));
            }
        }
    }, delay);

    reconnectTimers.set(guildId, timer);
}

client.on('voiceStateUpdate', (oldState, newState) => {
    const guildId = newState.guild.id;
    const connection = connections.get(guildId);
    const channelId = connection?.joinConfig.channelId;

    if (!activeStreams.has(guildId) || !channelId) return;
    if (oldState.channelId !== channelId && newState.channelId !== channelId) return;

    if (!hasHumanListeners(guildId)) {
        pauseStream(guildId);
        return;
    }

    const timer = reconnectTimers.get(guildId);
    if (timer) clearTimeout(timer);
    reconnectTimers.delete(guildId);

    try {
        startPlayback(guildId);
    } catch (err) {
        reportStreamError(guildId, err);
        scheduleReconnect(guildId);
    }
});

async function handlePlay(interaction) {
    const voiceChannel = interaction.member.voice.channel;
    const guildId = interaction.guildId;

    if (!voiceChannel) {
        return interaction.reply({ content: '❌ Rejoins un salon vocal d’abord !', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    stopStream(guildId, true);
    activeStreams.add(guildId);
    if (interaction.channel?.isTextBased()) notificationChannels.set(guildId, interaction.channel);

    saveSession.run(guildId, voiceChannel.id);
    createVoiceSession(guildId, voiceChannel.id, interaction.guild.voiceAdapterCreator);

    startPlayback(guildId);

    await interaction.editReply(`🎶 Radio lancée dans **${voiceChannel.name}** en 24/7`);
}

async function handleStop(interaction) {
    deleteSession.run(interaction.guildId);
    stopStream(interaction.guildId);
    await interaction.reply('⏹️ Radio arrêtée (bot reste connecté)');
}

async function handleDisconnect(interaction) {
    deleteSession.run(interaction.guildId);
    stopStream(interaction.guildId, true);

    await interaction.reply('🔌 Déconnecté du vocal');
}

async function handleVolume(interaction) {
    const volume = interaction.options.getInteger('level');
    const player = players.get(interaction.guildId);
    if (!player) return interaction.reply({ content: '❌ Aucun stream en cours.', flags: MessageFlags.Ephemeral });

    const resource = player.state.resource;
    if (resource?.volume) {
        resource.volume.setVolume(volume / 100);
        await interaction.reply(`🔊 Volume réglé à ${volume}%`);
    } else {
        await interaction.reply({ content: '❌ Volume non disponible.', flags: MessageFlags.Ephemeral });
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
