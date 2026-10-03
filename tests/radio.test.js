const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const discord = require('discord.js');
const { Backoff } = require('../reliability');

function fixture() {
    const state = { joins: 0, destroys: 0, sends: 0, sessions: [], clock: 1000000, timers: new Map(), children: [], logins: 0 };
    class Client extends EventEmitter {
        constructor() {
            super(); this.rest = new EventEmitter(); this.guilds = { cache: new discord.Collection() };
            this.user = { tag: 'test' }; state.client = this;
        }
        async login() { state.logins++; }
        destroy() {}
    }
    const voice = {
        AudioPlayerStatus: { Idle: 'idle', Playing: 'playing' },
        VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed', Signalling: 'signalling', Connecting: 'connecting' },
        VoiceConnectionDisconnectReason: { WebSocketClose: 0 }, StreamType: { Raw: 'raw' },
        joinVoiceChannel(config) {
            state.joins++;
            const connection = new EventEmitter();
            Object.assign(connection, { joinConfig: config, state: { status: 'ready' }, subscribe() {}, rejoin() { state.rejoins = (state.rejoins || 0) + 1; },
                destroy() { state.destroys++; this.state = { status: 'destroyed' }; } });
            return connection;
        },
        createAudioPlayer() {
            const player = new EventEmitter();
            player.state = { status: 'idle' };
            player.play = resource => { player.state = { status: 'playing', resource }; player.emit('playing'); };
            player.stop = () => { player.state = { status: 'idle' }; player.emit('idle'); };
            return player;
        },
        createAudioResource: () => ({ volume: { setVolume() {} } }),
        entersState: async (connection, status) => {
            if (connection.state.status !== status) throw new Error('Voice timeout');
            return connection;
        }
    };
    class Database {
        exec() {}
        close() {}
        prepare(sql) { return { all: () => state.sessions, run: () => { if (sql.startsWith('DELETE')) state.sessions = []; } }; }
    }
    const customRequire = name => {
        if (name === 'discord.js') return { ...discord, Client };
        if (name === '@discordjs/voice') return voice;
        if (name === 'dotenv') return { config() {} };
        if (name === 'fs') return { mkdirSync() {} };
        if (name === 'node:sqlite') return { DatabaseSync: Database };
        if (name === 'opusscript') return {};
        if (name === './reliability') return { ...require('../reliability'), monitorRest() {}, logError() {} };
        if (name === 'child_process') return { spawn: (_file, args) => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; };
            state.children.push(child);
            if (args[0] === '-version') queueMicrotask(() => child.emit('close', 0));
            return child;
        } };
        return require(name);
    };
    const context = vm.createContext({ require: customRequire, module: {}, __dirname: path.resolve(__dirname, '..'),
        console: { log() {}, error() {} }, process: { env: { DISCORD_TOKEN: 'offline', RADIO_URL: 'https://radio.invalid', FFMPEG_PATH: 'mock' }, once() {}, exit() { throw new Error('Unexpected exit'); } },
        setTimeout: (fn, delay) => { const timer = { fn, delay }; state.timers.set(timer, timer); return timer; },
        clearTimeout: timer => state.timers.delete(timer), Date: class extends Date { static now() { return state.clock; } } });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8'), context);
    const api = vm.runInContext('({ handlePlay, restoreSessions, scheduleReconnect, stopStream, reportStreamError, recoverVoice, start, connections, players, ffmpegProcesses, reconnectTimers, voiceRecoveries, retryBackoff, notificationChannels })', context);
    api.retryBackoff.random = () => 0;
    api.retryBackoff.now = () => state.clock;
    const channel = { id: 'voice', name: 'Radio', isVoiceBased: () => true, members: new discord.Collection([['human', { user: { bot: false } }]]) };
    const guild = { id: 'guild', voiceAdapterCreator: () => {}, channels: { cache: new discord.Collection([['voice', channel]]), fetch: async () => channel } };
    state.client.guilds.cache.set(guild.id, guild);
    const interaction = () => ({ guildId: guild.id, guild, member: { voice: { channel } }, channel: { isTextBased: () => true, send: async () => state.sends++ },
        deferReply: async () => {}, editReply: async () => {}, reply: async () => {} });
    return { state, api, guild, interaction };
}

test('concurrent /play calls keep a single voice connection', async () => {
    const { state, api, interaction } = fixture();
    await Promise.all(Array.from({ length: 10 }, () => api.handlePlay(interaction())));
    assert.equal(state.joins, 1);
    assert.equal(state.destroys, 0);
    assert.equal(api.players.get('guild').listenerCount('error'), 1);
});

test('restoration and /play cannot initialize the same session twice', async () => {
    const { state, api, interaction } = fixture();
    state.sessions = [{ guild_id: 'guild', channel_id: 'voice' }];
    await Promise.all([api.restoreSessions(), api.handlePlay(interaction())]);
    assert.equal(state.joins, 1);
    assert.equal(state.destroys, 0);
});

test('asynchronous stream failures increase backoff; duplicate events keep one timer', async () => {
    const { api, interaction } = fixture();
    await api.handlePlay(interaction());
    api.ffmpegProcesses.get('guild').emit('close', 1);
    api.players.get('guild').stop();
    const first = api.reconnectTimers.get('guild');
    assert.equal(first.delay, 10000);
    api.players.get('guild').emit('error', new Error('Duplicate'));
    assert.equal(api.reconnectTimers.get('guild'), first);
    await first.fn();
    api.ffmpegProcesses.get('guild').emit('close', 1);
    api.players.get('guild').stop();
    assert.equal(api.reconnectTimers.get('guild').delay, 20000);
});

test('mute/deafen updates cannot cancel pending recovery', async () => {
    const { state, api, guild, interaction } = fixture();
    await api.handlePlay(interaction());
    api.scheduleReconnect('guild');
    const timer = api.reconnectTimers.get('guild');
    state.client.emit('voiceStateUpdate', { channelId: 'voice' }, { channelId: 'voice', guild });
    assert.equal(api.reconnectTimers.get('guild'), timer);
});

test('voice kick stops the session without repeated rejoin attempts', async () => {
    const { state, api, interaction } = fixture();
    await api.handlePlay(interaction());
    const connection = api.connections.get('guild');
    connection.state = { status: 'disconnected', reason: 0, closeCode: 4014 };
    api.recoverVoice('guild', connection);
    await api.voiceRecoveries.get('guild');
    assert.equal(state.rejoins || 0, 0);
    assert.equal(api.connections.size, 0);
    assert.equal(api.reconnectTimers.size, 0);
});

test('notification cooldown survives replacing the voice session', async () => {
    const { state, api, interaction } = fixture();
    await api.handlePlay(interaction());
    const channel = interaction().channel;
    api.reportStreamError('guild', new Error('First'));
    api.stopStream('guild', true);
    api.notificationChannels.set('guild', channel);
    api.reportStreamError('guild', new Error('Again'));
    assert.equal(state.sends, 1);
});

test('prerequisites are checked before Discord login', async () => {
    const { state, api } = fixture();
    assert.equal(state.logins, 0);
    await api.start();
    assert.equal(state.children.length, 1);
    assert.equal(state.logins, 1);
});

test('backoff caps growth and resets only explicitly', () => {
    const backoff = new Backoff({ random: () => 0, now: () => 1000 });
    assert.deepEqual(Array.from({ length: 7 }, () => backoff.next('g')), [10000, 20000, 40000, 80000, 160000, 300000, 300000]);
    backoff.reset('g');
    assert.equal(backoff.next('g'), 10000);
});
