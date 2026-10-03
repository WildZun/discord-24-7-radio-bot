const test = require('node:test');
const assert = require('node:assert/strict');
const { REST, ApplicationCommand, Collection, SlashCommandBuilder } = require('discord.js');
const { guardRateLimitResponses, safeRoute, syncCommands } = require('../reliability');

function transport(makeRequest) {
    const rest = new REST({ makeRequest, offset: 0, hashSweepInterval: 0, handlerSweepInterval: 0 });
    guardRateLimitResponses(rest);
    return rest;
}

test('headerless HTML 429 stops after one request', async () => {
    for (const [body, headers] of [['<html>Blocked</html>', {}], ['null', {}], ['{}', { 'retry-after': 'Infinity' }]]) {
    let attempts = 0;
    const rest = transport(async () => { attempts++; return new Response(body, { status: 429, headers }); });
    await assert.rejects(rest.get('/test', { auth: false }), error => error.code === 'DISCORD_RATE_LIMIT_NO_DELAY');
    assert.equal(attempts, 1);
    }
});

test('JSON-only retry_after is respected by installed radio SDK', async () => {
    let attempts = 0;
    const rest = transport(async () => new Response(++attempts === 1 ? '{"retry_after":0.01,"global":true}' : '{}',
        { status: attempts === 1 ? 429 : 200, headers: { 'content-type': 'application/json' } }));
    const started = Date.now();
    await rest.get('/test', { auth: false });
    assert.equal(attempts, 2);
    assert.ok(Date.now() - started >= 9);
});

test('normal header-based limits and 5xx retry ceilings remain SDK-managed', async () => {
    let attempts = 0;
    const rest = transport(async () => new Response('{}', { status: ++attempts === 1 ? 429 : 200,
        headers: { 'content-type': 'application/json', 'retry-after': '0.01' } }));
    await rest.get('/test', { auth: false });
    assert.equal(attempts, 2);
    let failures = 0;
    const unavailable = transport(async () => { failures++; return new Response('{}', { status: 503 }); });
    await assert.rejects(unavailable.get('/test', { auth: false }));
    assert.equal(failures, 4);
});

test('telemetry hides tokens in sensitive routes', () => {
    assert.equal(safeRoute('/webhooks/123/secret/messages/456'), '/webhooks/123/:token/messages/456');
    assert.equal(safeRoute('/interactions/123/secret/callback'), '/interactions/123/:token/callback');
});

test('SDK command comparison handles camelCase options and server defaults', async () => {
    const definition = new SlashCommandBuilder().setName('volume').setDescription('Set volume.')
        .addIntegerOption(option => option.setName('level').setDescription('Level.').setRequired(true).setMinValue(1).setMaxValue(100));
    const remote = new ApplicationCommand({}, { ...definition.toJSON(), id: '123', application_id: '456', type: 1, contexts: [0, 1, 2], integration_types: [0], dm_permission: true });
    let writes = 0;
    const manager = { fetch: async () => new Collection([['id', remote]]), set: async () => writes++ };
    await syncCommands(manager, [definition]);
    assert.equal(writes, 0);
    definition.setDescription('Changed.');
    await syncCommands(manager, [definition]);
    assert.equal(writes, 1);
});
