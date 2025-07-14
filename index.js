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

// Check and force the use of opusscript on Windows ARM
try {
    require('opusscript');
    console.log('✅ Opus encoder (opusscript) loaded successfully');
} catch (error) {
    console.error('❌ Opusscript not found. Install it with: npm install opusscript');
    process.exit(1);
}

// Configuration
const TOKEN = process.env.DISCORD_TOKEN;
const RADIO_URL = process.env.RADIO_URL;

// Check if FFmpeg is available
const { spawn } = require('child_process');

function checkFFmpeg() {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', ['-version']);
        
        ffmpeg.on('error', () => {
            console.error('❌ FFmpeg not found. Make sure it is installed and in PATH.');
            resolve(false);
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log('✅ FFmpeg detected and functional');
                resolve(true);
            } else {
                console.error('❌ FFmpeg present but not functional');
                resolve(false);
            }
        });
    });
}

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Maps to manage connections per server
const connections = new Map();
const players = new Map();
const reconnectTimers = new Map();

// Event: Bot ready
client.once('ready', async () => {
    console.log(`${client.user.tag} is connected and ready!`);
    console.log(`🏗️ Architecture: ${process.arch}`);
    console.log(`💻 Platform: ${process.platform}`);
    console.log(`🔄 Mode: Permanent connection (24/7)`);
    
    // Check FFmpeg on startup
    const ffmpegOk = await checkFFmpeg();
    if (!ffmpegOk) {
        console.error('❌ Bot cannot start without FFmpeg');
        process.exit(1);
    }
    
    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('play')
            .setDescription('Start the webradio in 24/7 mode'),
        
        new SlashCommandBuilder()
            .setName('stop')
            .setDescription('Stop the webradio (but stay connected)'),
        
        new SlashCommandBuilder()
            .setName('disconnect')
            .setDescription('Completely disconnect the bot from voice channel'),
        
        new SlashCommandBuilder()
            .setName('pause')
            .setDescription('Pause the webradio'),
        
        new SlashCommandBuilder()
            .setName('resume')
            .setDescription('Resume webradio playback'),
        
        new SlashCommandBuilder()
            .setName('restart')
            .setDescription('Restart the webradio'),
        
        new SlashCommandBuilder()
            .setName('status')
            .setDescription('Show webradio status'),
        
        new SlashCommandBuilder()
            .setName('volume')
            .setDescription('Adjust radio volume')
            .addIntegerOption(option =>
                option.setName('level')
                    .setDescription('Volume level (1-100)')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(100)
            ),
        
        new SlashCommandBuilder()
            .setName('info')
            .setDescription('Show system information')
    ];

    try {
        await client.application.commands.set(commands);
        console.log('✅ Slash commands registered successfully!');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
});

// Event: Interaction (slash commands)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
        switch (commandName) {
            case 'play':
                await handlePlay(interaction);
                break;
            case 'stop':
                await handleStop(interaction);
                break;
            case 'disconnect':
                await handleDisconnect(interaction);
                break;
            case 'pause':
                await handlePause(interaction);
                break;
            case 'resume':
                await handleResume(interaction);
                break;
            case 'restart':
                await handleRestart(interaction);
                break;
            case 'status':
                await handleStatus(interaction);
                break;
            case 'volume':
                await handleVolume(interaction);
                break;
            case 'info':
                await handleInfo(interaction);
                break;
        }
    } catch (error) {
        console.error('❌ Error executing command:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
                content: '❌ An error occurred while executing the command.', 
                ephemeral: true 
            });
        }
    }
});

// Function: Create audio resource with automatic reconnection
async function createRadioResource(url, guildId) {
    try {
        const resource = createAudioResource(url, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
            metadata: {
                title: 'WebRadio Stream 24/7'
            }
        });
        
        // Set default volume
        if (resource.volume) {
            resource.volume.setVolume(0.5);
        }
        
        return resource;
    } catch (error) {
        console.error('❌ Error creating audio resource:', error);
        
        // Schedule a reconnection attempt
        scheduleReconnect(guildId);
        throw error;
    }
}

// Function: Schedule automatic reconnection
function scheduleReconnect(guildId, delay = 10000) {
    // Cancel previous timer if it exists
    if (reconnectTimers.has(guildId)) {
        clearTimeout(reconnectTimers.get(guildId));
    }
    
    const timer = setTimeout(async () => {
        const connection = connections.get(guildId);
        const player = players.get(guildId);
        
        if (connection && player) {
            console.log(`🔄 Automatic reconnection attempt for server ${guildId}...`);
            try {
                const resource = await createRadioResource(RADIO_URL, guildId);
                player.play(resource);
                console.log(`✅ Reconnection successful for server ${guildId}`);
            } catch (error) {
                console.error(`❌ Reconnection failed for server ${guildId}:`, error);
                // Retry with longer delay
                scheduleReconnect(guildId, Math.min(delay * 2, 60000));
            }
        }
        
        reconnectTimers.delete(guildId);
    }, delay);
    
    reconnectTimers.set(guildId, timer);
}

// Function: Start radio in 24/7 mode
async function handlePlay(interaction) {
    const guildId = interaction.guildId;
    
    if (!interaction.member.voice.channel) {
        return await interaction.reply({ 
            content: '❌ You must be in a voice channel to use this command!', 
            ephemeral: true 
        });
    }

    const voiceChannel = interaction.member.voice.channel;

    try {
        await interaction.deferReply();

        // If already connected, just restart the radio
        if (connections.has(guildId)) {
            const player = players.get(guildId);
            if (player) {
                const resource = await createRadioResource(RADIO_URL, guildId);
                player.play(resource);
                
                await interaction.editReply(`🎵 Radio restarted in **${voiceChannel.name}**!\n🔄 24/7 mode activated`);
                return;
            }
        }

        console.log(`🔗 Permanent connection to ${voiceChannel.name}...`);

        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        const player = createAudioPlayer();
        
        console.log(`📻 Creating audio resource for: ${RADIO_URL}`);
        const resource = await createRadioResource(RADIO_URL, guildId);

        player.play(resource);
        connection.subscribe(player);

        connections.set(guildId, connection);
        players.set(guildId, player);

        // Event handling to maintain 24/7 connection
        player.on(AudioPlayerStatus.Playing, () => {
            console.log(`🎵 24/7 radio playing in ${interaction.guild.name}`);
        });

        player.on(AudioPlayerStatus.Idle, () => {
            console.log('⏳ Player idle, automatic reconnection...');
            scheduleReconnect(guildId, 5000); // Quick reconnection on idle
        });

        player.on('error', (error) => {
            console.error('❌ Audio player error:', error);
            console.log('🔄 Attempting automatic recovery...');
            scheduleReconnect(guildId, 3000);
        });

        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log('✅ 24/7 voice connection ready');
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            console.log('🔌 Connection interrupted, attempting reconnection...');
            
            // Wait a bit then try to reconnect
            setTimeout(async () => {
                try {
                    if (connections.has(guildId)) {
                        const newConnection = joinVoiceChannel({
                            channelId: voiceChannel.id,
                            guildId: guildId,
                            adapterCreator: interaction.guild.voiceAdapterCreator,
                        });
                        
                        connections.set(guildId, newConnection);
                        const currentPlayer = players.get(guildId);
                        if (currentPlayer) {
                            newConnection.subscribe(currentPlayer);
                        }
                        
                        console.log('✅ Voice reconnection successful');
                    }
                } catch (error) {
                    console.error('❌ Voice reconnection error:', error);
                }
            }, 5000);
        });

        // Wait a bit to ensure connection is stable
        await new Promise(resolve => setTimeout(resolve, 2000));

        await interaction.editReply(
            `🎵 **24/7 Radio started** in **${voiceChannel.name}**!\n` +
            `🔄 **Permanent mode activated** - Bot will stay connected\n` +
            `🔊 Volume: 50%\n` +
            `💻 Windows ARM + FFmpeg + Opusscript\n` +
            `📻 URL: ${RADIO_URL}`
        );

    } catch (error) {
        console.error('❌ Connection error:', error);
        await interaction.editReply(`❌ Connection error: ${error.message}`);
    }
}

// Function: Stop radio but stay connected
async function handleStop(interaction) {
    const guildId = interaction.guildId;
    const player = players.get(guildId);
    const connection = connections.get(guildId);

    if (!connection) {
        return await interaction.reply({ 
            content: '❌ Bot is not connected to a voice channel!', 
            ephemeral: true 
        });
    }

    try {
        if (player) {
            player.stop();
            
            // Cancel reconnection timers
            if (reconnectTimers.has(guildId)) {
                clearTimeout(reconnectTimers.get(guildId));
                reconnectTimers.delete(guildId);
            }
        }

        await interaction.reply('⏹️ Radio stopped! (Bot still connected - use `/play` to restart)');
    } catch (error) {
        console.error('❌ Stop error:', error);
        await interaction.reply({ 
            content: '❌ Error stopping radio.', 
            ephemeral: true 
        });
    }
}

// Function: Completely disconnect
async function handleDisconnect(interaction) {
    const guildId = interaction.guildId;
    const connection = connections.get(guildId);
    const player = players.get(guildId);

    if (!connection) {
        return await interaction.reply({ 
            content: '❌ Bot is not connected to a voice channel!', 
            ephemeral: true 
        });
    }

    try {
        // Stop player
        if (player) {
            player.stop();
            players.delete(guildId);
        }
        
        // Cancel reconnection timers
        if (reconnectTimers.has(guildId)) {
            clearTimeout(reconnectTimers.get(guildId));
            reconnectTimers.delete(guildId);
        }
        
        // Disconnect
        connection.destroy();
        connections.delete(guildId);

        await interaction.reply('🔌 Bot completely disconnected from voice channel!');
    } catch (error) {
        console.error('❌ Disconnect error:', error);
        await interaction.reply({ 
            content: '❌ Error disconnecting.', 
            ephemeral: true 
        });
    }
}

// Function: Restart radio
async function handleRestart(interaction) {
    const guildId = interaction.guildId;
    const player = players.get(guildId);
    const connection = connections.get(guildId);

    if (!connection || !player) {
        return await interaction.reply({ 
            content: '❌ Bot is not connected! Use `/play` first.', 
            ephemeral: true 
        });
    }

    try {
        await interaction.deferReply();
        
        // Stop current player
        player.stop();
        
        // Cancel existing timers
        if (reconnectTimers.has(guildId)) {
            clearTimeout(reconnectTimers.get(guildId));
            reconnectTimers.delete(guildId);
        }
        
        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Restart with new resource
        const resource = await createRadioResource(RADIO_URL, guildId);
        player.play(resource);

        await interaction.editReply('🔄 Radio restarted successfully!');
    } catch (error) {
        console.error('❌ Restart error:', error);
        await interaction.editReply(`❌ Restart error: ${error.message}`);
    }
}

// Function: Pause
async function handlePause(interaction) {
    const player = players.get(interaction.guildId);

    if (!player) {
        return await interaction.reply({ 
            content: '❌ No radio currently playing!', 
            ephemeral: true 
        });
    }

    try {
        player.pause();
        await interaction.reply('⏸️ Radio paused!');
    } catch (error) {
        console.error('❌ Pause error:', error);
        await interaction.reply({ 
            content: '❌ Error pausing.', 
            ephemeral: true 
        });
    }
}

// Function: Resume
async function handleResume(interaction) {
    const player = players.get(interaction.guildId);

    if (!player) {
        return await interaction.reply({ 
            content: '❌ No radio on pause!', 
            ephemeral: true 
        });
    }

    try {
        player.unpause();
        await interaction.reply('▶️ Radio resumed!');
    } catch (error) {
        console.error('❌ Resume error:', error);
        await interaction.reply({ 
            content: '❌ Error resuming.', 
            ephemeral: true 
        });
    }
}

// Function: Volume
async function handleVolume(interaction) {
    const player = players.get(interaction.guildId);
    const volume = interaction.options.getInteger('level');

    if (!player) {
        return await interaction.reply({ 
            content: '❌ No radio currently playing!', 
            ephemeral: true 
        });
    }

    try {
        const resource = player.state.resource;
        if (resource && resource.volume) {
            resource.volume.setVolume(volume / 100);
            await interaction.reply(`🔊 Volume adjusted to ${volume}%`);
        } else {
            await interaction.reply({ 
                content: '❌ Cannot adjust volume for this audio source.', 
                ephemeral: true 
            });
        }
    } catch (error) {
        console.error('❌ Volume adjustment error:', error);
        await interaction.reply({ 
            content: '❌ Error adjusting volume.', 
            ephemeral: true 
        });
    }
}

// Function: Status
async function handleStatus(interaction) {
    const connection = connections.get(interaction.guildId);
    const player = players.get(interaction.guildId);

    if (!connection) {
        return await interaction.reply({ 
            content: '❌ Bot is not connected to a voice channel!', 
            ephemeral: true 
        });
    }

    let status = '🔌 Connected but not playing';
    let volumeInfo = 'N/A';

    if (player) {
        const playerState = player.state.status;
        switch (playerState) {
            case AudioPlayerStatus.Playing:
                status = '🎵 Playing (24/7)';
                break;
            case AudioPlayerStatus.Paused:
                status = '⏸️ Paused';
                break;
            case AudioPlayerStatus.Idle:
                status = '⏹️ Stopped';
                break;
            case AudioPlayerStatus.Buffering:
                status = '⏳ Buffering';
                break;
        }

        const resource = player.state.resource;
        if (resource && resource.volume) {
            const currentVolume = Math.round(resource.volume.volume * 100);
            volumeInfo = `${currentVolume}%`;
        }
    }

    const voiceChannel = client.channels.cache.get(connection.joinConfig.channelId);
    const hasReconnectTimer = reconnectTimers.has(interaction.guildId);

    const embed = new EmbedBuilder()
        .setTitle('🎵 24/7 WebRadio Status')
        .setDescription(
            `**Status:** ${status}\n` +
            `**Channel:** ${voiceChannel ? voiceChannel.name : 'Unknown'}\n` +
            `**Volume:** ${volumeInfo}\n` +
            `**Mode:** 24/7 (Permanent connection)\n` +
            `**Auto-reconnect:** ${hasReconnectTimer ? '🔄 Scheduled' : '✅ Ready'}\n` +
            `**Platform:** Windows ARM + Opusscript`
        )
        .setColor(0x00ff00)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// Function: System info
async function handleInfo(interaction) {
    const os = require('os');
    
    let opusEncoder = 'None';
    try {
        require('opusscript');
        opusEncoder = 'opusscript ✅';
    } catch {
        opusEncoder = 'None ❌';
    }
    
    const embed = new EmbedBuilder()
        .setTitle('ℹ️ 24/7 Radio Bot Information')
        .addFields(
            { name: '🤖 Bot', value: client.user.tag, inline: true },
            { name: '📡 Servers', value: client.guilds.cache.size.toString(), inline: true },
            { name: '🎵 24/7 Connections', value: connections.size.toString(), inline: true },
            { name: '💻 OS', value: `${os.type()} ${os.release()}`, inline: true },
            { name: '🏗️ Architecture', value: process.arch, inline: true },
            { name: '🟢 Node.js', value: process.version, inline: true },
            { name: '📦 Discord.js', value: require('discord.js').version, inline: true },
            { name: '🎚️ FFmpeg', value: 'System (Windows ARM)', inline: true },
            { name: '🔊 Opus Encoder', value: opusEncoder, inline: true },
            { name: '📻 Radio URL', value: RADIO_URL ? '✅ Configured' : '❌ Not configured', inline: true },
            { name: '🔄 Active Timers', value: reconnectTimers.size.toString(), inline: true },
            { name: '⏰ Mode', value: '24/7 (Permanent)', inline: true }
        )
        .setColor(0x00ff00)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

// Error handling
client.on('error', console.error);

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled rejection:', error);
});

process.on('SIGINT', () => {
    console.log('🛑 Stopping bot...');
    // Clean up all timers
    for (const [guildId, timer] of reconnectTimers) {
        clearTimeout(timer);
    }
    // Clean up all connections
    for (const [guildId, connection] of connections) {
        const player = players.get(guildId);
        if (player) player.stop();
        connection.destroy();
    }
    process.exit(0);
});

// Start the bot
if (!TOKEN) {
    console.error('❌ DISCORD_TOKEN not found in .env file');
    process.exit(1);
}

if (!RADIO_URL) {
    console.error('❌ RADIO_URL not found in .env file');
    process.exit(1);
}

client.login(TOKEN);