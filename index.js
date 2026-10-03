const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    VoiceConnectionDisconnectReason,
    entersState,
    StreamType
} = require('@discordjs/voice');
require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
const { Backoff, createSerializer, logError, syncCommands, monitorRest } = require('./reliability');

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
console.log('📻 Radio URL et token configurés');

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
monitorRest(client);

const connections = new Map();
const players = new Map();
const reconnectTimers = new Map();
const ffmpegProcesses = new Map();
const activeStreams = new Set();
const notificationChannels = new Map();
const lastErrorNotices = new Map();
const healthyTimers = new Map();
const voiceRecoveries = new Map();
const retryBackoff = new Backoff();
const serializeGuild = createSerializer();
const lastSessionChanges = new Map();
let nextErrorNotice = 0;
let shuttingDown = false;

client.once('ready', async () => {
    console.log(`${client.user.tag} est connecté et prêt !`);
    console.log(`🏗️ Architecture: ${process.arch}`);
    console.log(`💻 Plateforme: ${process.platform}`);
    console.log(`🔄 Mode: Connexion permanente (24/7)`);

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
        await syncCommands(client.application.commands, commands);
        console.log('✅ Commandes slash enregistrées');
    } catch (err) {
        logError('Command registration', err);
    }

    if (!shuttingDown) await restoreSessions().catch(error => logError('Session restoration', error));
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
        logError('Command', err);
        if ([10062, 10015, 40060].includes(Number(err.code))) return;
        if (interaction.deferred) {
            await interaction.editReply('❌ Impossible de lancer ou gérer ce flux radio. Consulte les logs du bot.').catch(error => logError('Command error response', error));
        } else if (!interaction.replied) {
            await interaction.reply({ content: '❌ Erreur pendant la commande.', flags: MessageFlags.Ephemeral }).catch(error => logError('Command error response', error));
        }
    }
});

function stopFFmpeg(guildId) {
    const ffmpeg = ffmpegProcesses.get(guildId);
    ffmpegProcesses.delete(guildId);

    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill();
}

function reportStreamError(guildId, error) {
    logError(`Radio stream ${guildId}`, error);

    const now = Date.now();
    if (now - (lastErrorNotices.get(guildId) || 0) < 60000) return;
    lastErrorNotices.set(guildId, now);
    if (now < nextErrorNotice) return;
    nextErrorNotice = now + 1000;

    const channel = notificationChannels.get(guildId);
    if (channel?.isTextBased()) {
        channel.send('⚠️ Flux radio interrompu. Reconnexion automatique en cours.').catch(err => {
            if (err.status === 403 || Number(err.code) === 10003) notificationChannels.delete(guildId);
            logError(`Stream notification ${guildId}`, err);
        });
    }
}

function stopStream(guildId, disconnect = false) {
    activeStreams.delete(guildId);
    retryBackoff.reset(guildId);
    clearHealthyTimer(guildId);
    stopFFmpeg(guildId);

    const timer = reconnectTimers.get(guildId);
    if (timer) clearTimeout(timer);
    reconnectTimers.delete(guildId);

    const player = players.get(guildId);
    if (player) player.stop();
    players.delete(guildId);

    if (disconnect) {
        const connection = connections.get(guildId);
        connections.delete(guildId);
        voiceRecoveries.delete(guildId);
        if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        notificationChannels.delete(guildId);
    }
}

function clearHealthyTimer(guildId) {
    const timer = healthyTimers.get(guildId);
    if (timer) clearTimeout(timer);
    healthyTimers.delete(guildId);
}

function createVoiceSession(guildId, channelId, adapterCreator) {
    const connection = joinVoiceChannel({ channelId, guildId, adapterCreator });
    const player = createAudioPlayer();
    connection.subscribe(player);

    players.set(guildId, player);
    connections.set(guildId, connection);

    player.on(AudioPlayerStatus.Idle, () => {
        if (players.get(guildId) !== player) return;
        clearHealthyTimer(guildId);
        scheduleReconnect(guildId);
    });

    player.on(AudioPlayerStatus.Playing, () => {
        if (players.get(guildId) !== player) return;
        clearHealthyTimer(guildId);
        healthyTimers.set(guildId, setTimeout(() => {
            healthyTimers.delete(guildId);
            if (players.get(guildId) === player && player.state.status === AudioPlayerStatus.Playing) retryBackoff.reset(guildId);
        }, 30000));
    });

    player.on('error', err => {
        if (players.get(guildId) !== player) return;
        clearHealthyTimer(guildId);
        if (activeStreams.has(guildId)) reportStreamError(guildId, err);
        scheduleReconnect(guildId);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
        if (connections.get(guildId) !== connection) return;
        if (activeStreams.has(guildId)) reportStreamError(guildId, new Error('Connexion vocale Discord interrompue'));
        recoverVoice(guildId, connection);
    });
    connection.on('error', error => {
        if (connections.get(guildId) !== connection) return;
        reportStreamError(guildId, error);
        scheduleReconnect(guildId);
    });
    return connection;
}

function recoverVoice(guildId, connection) {
    if (voiceRecoveries.has(guildId)) return;
    const recovery = (async () => {
        try {
            if (connection.state.reason === VoiceConnectionDisconnectReason.WebSocketClose && connection.state.closeCode === 4014) {
                // Moves can recover. Kicks must not cause repeated automatic joins.
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5000)
                ]);
                await entersState(connection, VoiceConnectionStatus.Ready, 20000);
            } else {
                await entersState(connection, VoiceConnectionStatus.Ready, 5000);
            }
            if (connections.get(guildId) === connection) startPlayback(guildId);
        } catch (error) {
            if (connections.get(guildId) !== connection || !activeStreams.has(guildId)) return;
            if (connection.state.closeCode === 4014) {
                await serializeGuild(guildId, () => {
                    if (connections.get(guildId) !== connection) return;
                    deleteSession.run(guildId);
                    stopStream(guildId, true);
                });
                logError(`Voice session stopped after kick ${guildId}`, error);
            } else {
                scheduleReconnect(guildId);
            }
        }
    })();
    voiceRecoveries.set(guildId, recovery);
    recovery.finally(() => {
        if (voiceRecoveries.get(guildId) === recovery) voiceRecoveries.delete(guildId);
    }).catch(error => logError(`Voice recovery ${guildId}`, error));
}

async function restoreSessions() {
    for (const { guild_id: guildId, channel_id: channelId } of getSessions.all()) {
        await serializeGuild(guildId, async () => {
            if (shuttingDown || activeStreams.has(guildId)) return;
            const guild = client.guilds.cache.get(guildId);
            if (!guild) {
                console.error(`❌ Guild sauvegardée inaccessible: ${guildId}`);
                return;
            }

            try {
                const channel = await guild.channels.fetch(channelId);
                if (!channel?.isVoiceBased()) {
                    deleteSession.run(guildId);
                    console.error(`❌ Salon vocal sauvegardé introuvable: ${guildId}/${channelId}`);
                    return;
                }

                activeStreams.add(guildId);
                const connection = createVoiceSession(guildId, channel.id, guild.voiceAdapterCreator);
                await entersState(connection, VoiceConnectionStatus.Ready, 20000);
                startPlayback(guildId);
                console.log(`✅ Session restaurée pour ${guildId}`);
            } catch (err) {
                if (Number(err.code) === 10003) deleteSession.run(guildId);
                if (connections.has(guildId)) scheduleReconnect(guildId);
                logError(`Session restore ${guildId}`, err);
            }
        });
    }
}

function hasHumanListeners(guildId) {
    const connection = connections.get(guildId);
    const channelId = connection?.joinConfig.channelId;
    const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);

    return channel?.isVoiceBased() && channel.members.some(member => !member.user.bot);
}

function pauseStream(guildId) {
    clearHealthyTimer(guildId);
    const timer = reconnectTimers.get(guildId);
    if (timer) clearTimeout(timer);
    reconnectTimers.delete(guildId);
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
    if (connections.get(guildId)?.state.status !== VoiceConnectionStatus.Ready) {
        scheduleReconnect(guildId);
        return;
    }

    const resource = createRadioResource(RADIO_URL, guildId);
    player.play(resource);
    console.log(`▶️ Flux lancé pour ${guildId}`);
}

function scheduleReconnect(guildId) {
    if (shuttingDown || !activeStreams.has(guildId) || !hasHumanListeners(guildId) || reconnectTimers.has(guildId)) return;
    clearHealthyTimer(guildId);
    const delay = retryBackoff.next(guildId);

    const timer = setTimeout(async () => {
        if (reconnectTimers.get(guildId) !== timer) return;
        reconnectTimers.delete(guildId);

        if (!activeStreams.has(guildId) || !hasHumanListeners(guildId)) return;
        await serializeGuild(guildId, async () => {
            if (shuttingDown || !activeStreams.has(guildId) || !hasHumanListeners(guildId)) return;
            if (players.has(guildId)) {
                try {
                    const connection = connections.get(guildId);
                    if (!connection || connection.state.status === VoiceConnectionStatus.Destroyed) return;
                    if (connection.state.status === VoiceConnectionStatus.Disconnected) connection.rejoin();
                    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
                    startPlayback(guildId);
                } catch (err) {
                    logError(`Reconnect ${guildId}`, err);
                    scheduleReconnect(guildId);
                }
            }
        }).catch(error => logError(`Reconnect task ${guildId}`, error));
    }, delay);

    reconnectTimers.set(guildId, timer);
}

client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.channelId === newState.channelId) return;
    const guildId = newState.guild.id;
    const connection = connections.get(guildId);
    const channelId = connection?.joinConfig.channelId;

    if (!activeStreams.has(guildId) || !channelId) return;
    if (oldState.channelId !== channelId && newState.channelId !== channelId) return;

    if (!hasHumanListeners(guildId)) {
        pauseStream(guildId);
        return;
    }

    if (reconnectTimers.has(guildId)) return;
    if (retryBackoff.remaining(guildId) > 0) {
        scheduleReconnect(guildId);
        return;
    }

    try {
        startPlayback(guildId);
    } catch (err) {
        reportStreamError(guildId, err);
        scheduleReconnect(guildId);
    }
});

async function handlePlay(interaction) {
    const voiceChannel = interaction.member?.voice?.channel;
    const guildId = interaction.guildId;

    if (!voiceChannel) {
        return interaction.reply({ content: '❌ Rejoins un salon vocal d’abord !', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    return serializeGuild(guildId, async () => {
        if (shuttingDown) return interaction.editReply('⏳ Bot en cours d’arrêt.');
        if (interaction.member.voice.channel?.id !== voiceChannel.id) return interaction.editReply('❌ Ton salon vocal a changé. Relance la commande.');
        const current = connections.get(guildId);
        if (activeStreams.has(guildId) && current?.joinConfig.channelId === voiceChannel.id && current.state.status !== VoiceConnectionStatus.Destroyed) {
            return interaction.editReply(`🎶 Radio déjà active dans **${voiceChannel.name}**.`);
        }
        if (Date.now() - (lastSessionChanges.get(guildId) || 0) < 5000) return interaction.editReply('⏳ Patiente 5 secondes entre les changements de salon.');
        lastSessionChanges.set(guildId, Date.now());
        stopStream(guildId, true);
        activeStreams.add(guildId);
        if (interaction.channel?.isTextBased()) notificationChannels.set(guildId, interaction.channel);

        saveSession.run(guildId, voiceChannel.id);
        const connection = createVoiceSession(guildId, voiceChannel.id, interaction.guild.voiceAdapterCreator);
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        } catch (error) {
            scheduleReconnect(guildId);
            throw error;
        }

        startPlayback(guildId);

        await interaction.editReply(`🎶 Radio lancée dans **${voiceChannel.name}** en 24/7`);
    });
}

async function handleStop(interaction) {
    await interaction.deferReply();
    return serializeGuild(interaction.guildId, async () => {
        deleteSession.run(interaction.guildId);
        stopStream(interaction.guildId);
        await interaction.editReply('⏹️ Radio arrêtée (bot reste connecté)');
    });
}

async function handleDisconnect(interaction) {
    await interaction.deferReply();
    return serializeGuild(interaction.guildId, async () => {
        deleteSession.run(interaction.guildId);
        stopStream(interaction.guildId, true);

        await interaction.editReply('🔌 Déconnecté du vocal');
    });
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

async function start() {
    if (!await checkFFmpeg()) throw new Error('FFmpeg non fonctionnel ou absent.');
    await client.login(TOKEN);
}

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const guildId of connections.keys()) stopStream(guildId, true);
    client.destroy();
    database.close();
}

process.once('SIGINT', () => shutdown().catch(error => logError('Shutdown', error)));
process.once('SIGTERM', () => shutdown().catch(error => logError('Shutdown', error)));
client.on('error', error => logError('Discord client', error));

if (require.main === module) {
    start().catch(error => {
        logError('Startup', error);
        process.exitCode = 1;
        client.destroy();
        database.close();
    });
}
