"use strict";
/**
 * Minimal Redis Streams client via Upstash REST API (no extra dependency).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisStreamsError = void 0;
exports.redisCommand = redisCommand;
exports.xadd = xadd;
exports.xgroupCreateMkStream = xgroupCreateMkStream;
exports.xreadgroup = xreadgroup;
exports.xack = xack;
exports.xlen = xlen;
exports.xpendingSummary = xpendingSummary;
exports.xautoclaim = xautoclaim;
const signalQueueConfig_1 = require("./signalQueueConfig");
class RedisStreamsError extends Error {
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = 'RedisStreamsError';
    }
}
exports.RedisStreamsError = RedisStreamsError;
async function redisCommand(...args) {
    const cfg = (0, signalQueueConfig_1.signalQueueConfig)();
    if (!cfg.redisRestUrl || !cfg.redisRestToken) {
        throw new RedisStreamsError('Redis REST URL/token not configured');
    }
    const res = await fetch(cfg.redisRestUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${cfg.redisRestToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(args.map(String)),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new RedisStreamsError(`Redis HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json());
    if (data.error) {
        throw new RedisStreamsError(String(data.error));
    }
    return data.result;
}
async function xadd(stream, fields) {
    const flat = [];
    for (const [k, v] of Object.entries(fields)) {
        flat.push(k, v);
    }
    const result = await redisCommand('XADD', stream, '*', ...flat);
    return String(result ?? '');
}
async function xgroupCreateMkStream(stream, group) {
    try {
        await redisCommand('XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('BUSYGROUP'))
            return;
        throw err;
    }
}
function parseStreamMessages(raw) {
    if (!Array.isArray(raw) || raw.length === 0)
        return [];
    const streamBlock = raw[0];
    if (!Array.isArray(streamBlock) || streamBlock.length < 2)
        return [];
    const entries = streamBlock[1];
    if (!Array.isArray(entries))
        return [];
    const out = [];
    for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length < 2)
            continue;
        const id = String(entry[0]);
        const fieldList = entry[1];
        const fields = {};
        if (Array.isArray(fieldList)) {
            for (let i = 0; i + 1 < fieldList.length; i += 2) {
                fields[String(fieldList[i])] = String(fieldList[i + 1]);
            }
        }
        out.push({ id, fields });
    }
    return out;
}
async function xreadgroup(group, consumer, stream, count, blockMs) {
    const raw = await redisCommand('XREADGROUP', 'GROUP', group, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', stream, '>');
    return parseStreamMessages(raw);
}
async function xack(stream, group, messageId) {
    const result = await redisCommand('XACK', stream, group, messageId);
    return Number(result ?? 0);
}
async function xlen(stream) {
    const result = await redisCommand('XLEN', stream);
    return Number(result ?? 0);
}
async function xpendingSummary(stream, group) {
    const raw = await redisCommand('XPENDING', stream, group);
    if (!Array.isArray(raw)) {
        return { pending: 0, minId: null, maxId: null, consumers: [] };
    }
    const pending = Number(raw[0] ?? 0);
    const minId = raw[1] != null ? String(raw[1]) : null;
    const maxId = raw[2] != null ? String(raw[2]) : null;
    const consumersRaw = Array.isArray(raw[3]) ? raw[3] : [];
    const consumers = consumersRaw.map(row => {
        if (!Array.isArray(row))
            return { name: '?', pending: 0 };
        return { name: String(row[0]), pending: Number(row[1] ?? 0) };
    });
    return { pending, minId, maxId, consumers };
}
async function xautoclaim(stream, group, consumer, minIdleMs, startId, count) {
    const raw = await redisCommand('XAUTOCLAIM', stream, group, consumer, minIdleMs, startId, 'COUNT', count);
    if (!Array.isArray(raw)) {
        return { nextStart: '0-0', messages: [] };
    }
    const nextStart = String(raw[0] ?? '0-0');
    const entries = raw[1];
    const messages = [];
    if (Array.isArray(entries)) {
        for (const entry of entries) {
            if (!Array.isArray(entry) || entry.length < 2)
                continue;
            const id = String(entry[0]);
            const fieldList = entry[1];
            const fields = {};
            if (Array.isArray(fieldList)) {
                for (let i = 0; i + 1 < fieldList.length; i += 2) {
                    fields[String(fieldList[i])] = String(fieldList[i + 1]);
                }
            }
            messages.push({ id, fields });
        }
    }
    return { nextStart, messages };
}
