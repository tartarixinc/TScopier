/**
 * Minimal Redis Streams client via Upstash REST API (no extra dependency).
 */

import { signalQueueConfig } from './signalQueueConfig'

export class RedisStreamsError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'RedisStreamsError'
  }
}

type RedisRestResponse = {
  result?: unknown
  error?: string
}

export async function redisCommand(...args: Array<string | number>): Promise<unknown> {
  const cfg = signalQueueConfig()
  if (!cfg.redisRestUrl || !cfg.redisRestToken) {
    throw new RedisStreamsError('Redis REST URL/token not configured')
  }

  const res = await fetch(cfg.redisRestUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.redisRestToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args.map(String)),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new RedisStreamsError(`Redis HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as RedisRestResponse
  if (data.error) {
    throw new RedisStreamsError(String(data.error))
  }
  return data.result
}

export async function xadd(
  stream: string,
  fields: Record<string, string>,
): Promise<string> {
  const flat: string[] = []
  for (const [k, v] of Object.entries(fields)) {
    flat.push(k, v)
  }
  const result = await redisCommand('XADD', stream, '*', ...flat)
  return String(result ?? '')
}

export async function xgroupCreateMkStream(stream: string, group: string): Promise<void> {
  try {
    await redisCommand('XGROUP', 'CREATE', stream, group, '0', 'MKSTREAM')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('BUSYGROUP')) return
    throw err
  }
}

export type StreamMessage = {
  id: string
  fields: Record<string, string>
}

function parseStreamMessages(raw: unknown): StreamMessage[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  const streamBlock = raw[0]
  if (!Array.isArray(streamBlock) || streamBlock.length < 2) return []
  const entries = streamBlock[1]
  if (!Array.isArray(entries)) return []

  const out: StreamMessage[] = []
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const id = String(entry[0])
    const fieldList = entry[1]
    const fields: Record<string, string> = {}
    if (Array.isArray(fieldList)) {
      for (let i = 0; i + 1 < fieldList.length; i += 2) {
        fields[String(fieldList[i])] = String(fieldList[i + 1])
      }
    }
    out.push({ id, fields })
  }
  return out
}

export async function xreadgroup(
  group: string,
  consumer: string,
  stream: string,
  count: number,
  blockMs: number,
): Promise<StreamMessage[]> {
  const raw = await redisCommand(
    'XREADGROUP', 'GROUP', group, consumer,
    'COUNT', count,
    'BLOCK', blockMs,
    'STREAMS', stream, '>',
  )
  return parseStreamMessages(raw)
}

export async function xack(stream: string, group: string, messageId: string): Promise<number> {
  const result = await redisCommand('XACK', stream, group, messageId)
  return Number(result ?? 0)
}

export async function xlen(stream: string): Promise<number> {
  const result = await redisCommand('XLEN', stream)
  return Number(result ?? 0)
}

export type PendingSummary = {
  pending: number
  minId: string | null
  maxId: string | null
  consumers: Array<{ name: string; pending: number }>
}

export async function xpendingSummary(stream: string, group: string): Promise<PendingSummary> {
  const raw = await redisCommand('XPENDING', stream, group)
  if (!Array.isArray(raw)) {
    return { pending: 0, minId: null, maxId: null, consumers: [] }
  }
  const pending = Number(raw[0] ?? 0)
  const minId = raw[1] != null ? String(raw[1]) : null
  const maxId = raw[2] != null ? String(raw[2]) : null
  const consumersRaw = Array.isArray(raw[3]) ? raw[3] : []
  const consumers = consumersRaw.map(row => {
    if (!Array.isArray(row)) return { name: '?', pending: 0 }
    return { name: String(row[0]), pending: Number(row[1] ?? 0) }
  })
  return { pending, minId, maxId, consumers }
}

export async function xautoclaim(
  stream: string,
  group: string,
  consumer: string,
  minIdleMs: number,
  startId: string,
  count: number,
): Promise<{ nextStart: string; messages: StreamMessage[] }> {
  const raw = await redisCommand(
    'XAUTOCLAIM', stream, group, consumer,
    minIdleMs, startId, 'COUNT', count,
  )
  if (!Array.isArray(raw)) {
    return { nextStart: '0-0', messages: [] }
  }
  const nextStart = String(raw[0] ?? '0-0')
  const entries = raw[1]
  const messages: StreamMessage[] = []
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const id = String(entry[0])
      const fieldList = entry[1]
      const fields: Record<string, string> = {}
      if (Array.isArray(fieldList)) {
        for (let i = 0; i + 1 < fieldList.length; i += 2) {
          fields[String(fieldList[i])] = String(fieldList[i + 1])
        }
      }
      messages.push({ id, fields })
    }
  }
  return { nextStart, messages }
}
