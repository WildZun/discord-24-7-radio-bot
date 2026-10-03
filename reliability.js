class Backoff {
    constructor({ base = 10000, maximum = 300000, random = Math.random, now = Date.now } = {}) {
        this.base = base;
        this.maximum = maximum;
        this.random = random;
        this.now = now;
        this.states = new Map();
    }

    next(key) {
        const attempts = Math.min((this.states.get(key)?.attempts || 0) + 1, 20);
        const delay = Math.min(this.maximum, this.base * 2 ** (attempts - 1) * (1 + this.random() * 0.2));
        this.states.set(key, { attempts, deadline: this.now() + delay });
        return delay;
    }

    remaining(key) {
        return Math.max(0, (this.states.get(key)?.deadline || 0) - this.now());
    }

    reset(key) {
        this.states.delete(key);
    }
}

function createSerializer() {
    const queues = new Map();
    return (key, operation) => {
        const result = (queues.get(key) || Promise.resolve()).then(operation);
        const tail = result.catch(() => {});
        queues.set(key, tail);
        tail.then(() => {
            if (queues.get(key) === tail) queues.delete(key);
        });
        return result;
    };
}

function logError(context, error) {
    console.error(JSON.stringify({ time: new Date().toISOString(), context, code: error?.code, status: error?.status,
        name: error?.name || (typeof error === 'string' ? 'StreamError' : undefined),
        message: String(error?.message || (typeof error === 'string' ? error : '')).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 1000) }));
}

async function syncCommands(manager, builders) {
    const definitions = builders.map(command => command.toJSON());
    const existing = await manager.fetch();
    const same = existing.size === definitions.length && definitions.every(definition => {
        const command = existing.find(remote => remote.name === definition.name && remote.type === (definition.type || 1));
        if (!command) return false;
        const comparison = { ...JSON.parse(JSON.stringify(definition)), contexts: definition.contexts ?? command.contexts ?? [],
            integration_types: definition.integration_types ?? command.integrationTypes ?? [] };
        if (command.guildId) delete comparison.dm_permission;
        return command.equals(comparison);
    });
    if (!same) await manager.set(definitions);
}

function safeRoute(value) {
    return String(value || '').split('?')[0].replace(/(\/(?:webhooks|interactions)\/[^/]+\/)[^/]+/g, '$1:token');
}

function guardRateLimitResponses(rest) {
    const request = rest.options.makeRequest;
    rest.options.makeRequest = async (...args) => {
        const response = await request(...args);
        const retryAfter = Number(response.headers.get('retry-after'));
        if (response.status !== 429 || (Number.isFinite(retryAfter) && retryAfter > 0)) return response;
        const text = await response.text();
        let data;
        try { data = JSON.parse(text) || {}; } catch { data = {}; }
        const delay = Math.max(Number(response.headers.get('x-ratelimit-reset-after')) || 0, Number(data.retry_after) || 0);
        if (!Number.isFinite(delay) || delay <= 0) {
            const error = new Error('Discord returned 429 without a usable retry delay; automatic retry stopped.');
            error.status = 429;
            error.code = 'DISCORD_RATE_LIMIT_NO_DELAY';
            throw error;
        }
        const headers = new Headers(response.headers);
        headers.set('retry-after', String(delay));
        if (data.global) {
            headers.set('x-ratelimit-global', 'true');
            headers.set('x-ratelimit-scope', 'global');
        }
        return new Response(text, { status: 429, statusText: response.statusText, headers });
    };
}

function monitorRest(client) {
    guardRateLimitResponses(client.rest);
    client.rest.options.invalidRequestWarningInterval = 100;
    client.rest.on('invalidRequestWarning', info => console.warn(JSON.stringify({ time: new Date().toISOString(), event: 'discord_invalid_requests', count: info.count, remainingTimeMs: info.remainingTime })));
    client.rest.on('rateLimited', info => console.warn(JSON.stringify({ time: new Date().toISOString(), event: 'discord_rate_wait', route: safeRoute(info.route), global: info.global, retryAfterMs: Math.max(info.timeToReset || 0, info.retryAfter || 0), scope: info.scope })));
    client.rest.on('response', (request, response) => {
        if (response.status < 400) return;
        console.warn(JSON.stringify({ time: new Date().toISOString(), event: 'discord_http_error', method: request.method, route: safeRoute(request.route), status: response.status,
            scope: response.headers.get('x-ratelimit-scope'), retryAfter: response.headers.get('retry-after'), bucket: response.headers.get('x-ratelimit-bucket') }));
    });
}

module.exports = { Backoff, createSerializer, logError, syncCommands, monitorRest, guardRateLimitResponses, safeRoute };
