import assert from 'node:assert/strict'
import test from 'node:test'
import { ensureSignalRow, isSignalFkViolation } from './ensureSignalRow'

test('isSignalFkViolation detects trades_signal_id_fkey', () => {
  assert.equal(
    isSignalFkViolation(
      'insert or update on table "trades" violates foreign key constraint "trades_signal_id_fkey"',
    ),
    true,
  )
})

test('isSignalFkViolation rejects unrelated errors', () => {
  assert.equal(isSignalFkViolation('duplicate key value'), false)
  assert.equal(isSignalFkViolation(null), false)
})

test('ensureSignalRow upserts by id via supabase client', async () => {
  const calls: Array<{ table: string; payload: unknown; opts: unknown }> = []
  const supabase = {
    from(table: string) {
      return {
        upsert(payload: unknown, opts: unknown) {
          calls.push({ table, payload, opts })
          return Promise.resolve({ error: null })
        },
      }
    },
  }

  const result = await ensureSignalRow(supabase as never, {
    id: '68b4b9a4-1111-2222-3333-444444444444',
    user_id: 'user-1',
    channel_id: 'ch-1',
    raw_message: 'Gold buy now',
    status: 'parsed',
    parsed_data: { action: 'buy', symbol: 'XAUUSD' },
    telegram_message_id: '359',
  })

  assert.equal(result.ok, true)
  assert.equal(result.written, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.table, 'signals')
  assert.deepEqual(calls[0]?.opts, { onConflict: 'id' })
  const payload = calls[0]?.payload as Record<string, unknown>
  assert.equal(payload.id, '68b4b9a4-1111-2222-3333-444444444444')
  assert.equal(payload.raw_message, 'Gold buy now')
  assert.equal(payload.telegram_message_id, '359')
})

test('ensureSignalRow falls back to stub without telegram_message_id on unique conflict', async () => {
  let attempt = 0
  const payloads: Record<string, unknown>[] = []
  const supabase = {
    from() {
      return {
        upsert(payload: Record<string, unknown>) {
          attempt += 1
          payloads.push(payload)
          if (attempt === 1) {
            return Promise.resolve({
              error: { message: 'duplicate key value violates unique constraint "signals_user_channel_telegram_message_unique_idx"' },
            })
          }
          return Promise.resolve({ error: null })
        },
        select() {
          const chain = {
            eq() {
              return chain
            },
            limit() {
              return Promise.resolve({ data: [], error: null })
            },
          }
          return chain
        },
      }
    },
  }

  const result = await ensureSignalRow(supabase as never, {
    id: '68b4b9a4-aaaa-bbbb-cccc-dddddddddddd',
    user_id: 'user-1',
    channel_id: 'ch-1',
    raw_message: 'Gold buy now',
    telegram_message_id: '359',
  })

  assert.equal(result.ok, true)
  assert.equal(result.duplicate, undefined)
  assert.equal(payloads.length, 2)
  assert.equal(payloads[1]?.telegram_message_id, null)
  assert.equal(payloads[1]?.id, '68b4b9a4-aaaa-bbbb-cccc-dddddddddddd')
})

test('ensureSignalRow detects duplicate telegram message and persists non-executable skipped stub', async () => {
  let attempt = 0
  const payloads: Record<string, unknown>[] = []
  const supabase = {
    from() {
      return {
        upsert(payload: Record<string, unknown>) {
          attempt += 1
          payloads.push(payload)
          if (attempt === 1) {
            return Promise.resolve({
              error: { message: 'duplicate key value violates unique constraint "signals_user_channel_telegram_message_unique_idx"' },
            })
          }
          return Promise.resolve({ error: null })
        },
        select() {
          const chain = {
            eq() {
              return chain
            },
            limit() {
              return Promise.resolve({
                data: [{ id: '68b4b9a4-1111-2222-3333-444444444444' }],
                error: null,
              })
            },
          }
          return chain
        },
      }
    },
  }

  const result = await ensureSignalRow(supabase as never, {
    id: '68b4b9a4-aaaa-bbbb-cccc-dddddddddddd',
    user_id: 'user-1',
    channel_id: 'ch-1',
    raw_message: 'BOOK 50% PROFITS',
    status: 'parsed',
    telegram_message_id: '359',
  })

  assert.equal(result.ok, true)
  assert.equal(result.duplicate, true)
  assert.equal(result.existingSignalId, '68b4b9a4-1111-2222-3333-444444444444')
  assert.equal(payloads.length, 2)
  const stub = payloads[1] ?? {}
  assert.equal(stub.telegram_message_id, null)
  assert.equal(stub.status, 'skipped', 'duplicate stub must never be executable')
  assert.equal(stub.skip_reason, 'duplicate_telegram_message')
})

test('ensureSignalRow duplicate Stefan complete entry replay does not execute twice', async () => {
  let attempt = 0
  const payloads: Record<string, unknown>[] = []
  const supabase = {
    from() {
      return {
        upsert(payload: Record<string, unknown>) {
          attempt += 1
          payloads.push(payload)
          if (attempt === 1) {
            return Promise.resolve({
              error: { message: 'duplicate key value violates unique constraint "signals_user_channel_telegram_message_unique_idx"' },
            })
          }
          return Promise.resolve({ error: null })
        },
        select() {
          const chain = {
            eq() {
              return chain
            },
            limit() {
              return Promise.resolve({
                data: [{ id: '11111111-1111-1111-1111-111111111111' }],
                error: null,
              })
            },
          }
          return chain
        },
      }
    },
  }

  const result = await ensureSignalRow(supabase as never, {
    id: '22222222-2222-2222-2222-222222222222',
    user_id: 'user-stefan',
    channel_id: 'channel-gold',
    raw_message: 'GOLD BUY SETUP\n\nGold Buy Zone 4441 - 4436\n\nSL : 4531\n\nTP1 : 4446\nTP2 : 4451\nTP3 : 4456\nTP4 : Hold',
    status: 'parsed',
    parsed_data: {
      action: 'buy',
      symbol: 'XAUUSD',
      entry_zone_low: 4436,
      entry_zone_high: 4441,
      sl: 4531,
      tp: [4446, 4451, 4456],
    },
    telegram_message_id: 'stefan-signal-4',
  })

  assert.equal(result.duplicate, true)
  assert.equal(result.existingSignalId, '11111111-1111-1111-1111-111111111111')
  assert.equal(payloads.length, 2)
  const stub = payloads[1] ?? {}
  assert.equal(stub.status, 'skipped')
  assert.equal(stub.skip_reason, 'duplicate_telegram_message')
  assert.equal(stub.telegram_message_id, null)
})

test('ensureSignalRow duplicate close message (incident 2348668186 shape): owner stays executable, loser stub is not', async () => {
  // Two deliveries of the same "Let's CLOSE our trade now" telegram message
  // raced the listener (live event + poll overlap). The FIRST call owns the
  // message; the SECOND must come back as duplicate and persist a stub that
  // the worker sweep can never execute (status 'skipped' is not 'parsed').
  const payloads: Record<string, unknown>[] = []
  const supabase = {
    from() {
      return {
        upsert(payload: Record<string, unknown>) {
          payloads.push(payload)
          if (payloads.length === 1) {
            return Promise.resolve({
              error: { message: 'duplicate key value violates unique constraint "signals_user_channel_telegram_message_unique_idx"' },
            })
          }
          return Promise.resolve({ error: null })
        },
        select() {
          const chain = {
            eq() {
              return chain
            },
            limit() {
              return Promise.resolve({
                data: [{ id: '94f52e2f-2ae1-4824-bdba-1f6a1b932873' }],
                error: null,
              })
            },
          }
          return chain
        },
      }
    },
  }

  const result = await ensureSignalRow(supabase as never, {
    id: '4ddcf865-eebf-4dfc-a2b9-42e781e192c7',
    user_id: '82756f8c-3b8a-4e9e-9614-3ad94e093781',
    channel_id: '0065c1d8-36cd-4e4c-b68b-26c7f68979a0',
    raw_message: "INSTANT 38pips✅\n\nLet's CLOSE our trade now and set breakeven if you wish to hold! United Kings are all about scalping traders🔥🔥🔥",
    status: 'parsed',
    parsed_data: { action: 'close', symbol: 'XAUUSD' },
    telegram_message_id: '19742',
  })

  assert.equal(result.ok, true)
  assert.equal(result.duplicate, true)
  assert.equal(result.existingSignalId, '94f52e2f-2ae1-4824-bdba-1f6a1b932873')
  assert.equal(payloads.length, 2)
  const stub = payloads[1] ?? {}
  assert.equal(stub.id, '4ddcf865-eebf-4dfc-a2b9-42e781e192c7')
  assert.equal(stub.telegram_message_id, null)
  assert.equal(stub.status, 'skipped', 'loser stub must never be executable by the sweep')
  assert.equal(stub.skip_reason, 'duplicate_telegram_message')
})

test('ensureSignalRow preserves existing raw_message when dispatch payload omits it', async () => {
  const calls: Array<{ payload: Record<string, unknown> }> = []
  const supabase = {
    from() {
      return {
        upsert(payload: Record<string, unknown>) {
          calls.push({ payload })
          return Promise.resolve({ error: null })
        },
      }
    },
  }

  const result = await ensureSignalRow(supabase as never, {
    id: '68b4b9a4-1111-2222-3333-444444444444',
    user_id: 'user-1',
    channel_id: 'ch-1',
    status: 'parsed',
    parsed_data: { action: 'modify', symbol: 'XAUUSD' },
    telegram_message_id: '6062',
  })

  assert.equal(result.ok, true)
  const payload = calls[0]?.payload ?? {}
  assert.equal('raw_message' in payload, false, 'raw_message must not be written when omitted')
})

test('ensureSignalRow preserves existing raw_message when raw_message is empty string', async () => {
  const calls: Array<{ payload: Record<string, unknown> }> = []
  const supabase = {
    from() {
      return {
        upsert(payload: Record<string, unknown>) {
          calls.push({ payload })
          return Promise.resolve({ error: null })
        },
      }
    },
  }

  const result = await ensureSignalRow(supabase as never, {
    id: '68b4b9a4-1111-2222-3333-444444444444',
    user_id: 'user-1',
    channel_id: 'ch-1',
    raw_message: '',
    status: 'parsed',
  })

  assert.equal(result.ok, true)
  const payload = calls[0]?.payload ?? {}
  assert.equal('raw_message' in payload, false, 'raw_message must not be written when empty')
})

test('ensureSignalRow omits source_kind when not provided so WhatsApp stamps are not clobbered', async () => {
  const calls: Array<{ payload: Record<string, unknown> }> = []
  const supabase = {
    from() {
      return {
        upsert(payload: Record<string, unknown>) {
          calls.push({ payload })
          return Promise.resolve({ error: null })
        },
      }
    },
  }

  const result = await ensureSignalRow(supabase as never, {
    id: '68b4b9a4-1111-2222-3333-444444444444',
    user_id: 'user-1',
    channel_id: 'wa-channel',
    status: 'parsed',
    parsed_data: { action: 'sell', symbol: 'XAUUSD' },
    telegram_message_id: 'wa-1',
  })

  assert.equal(result.ok, true)
  const payload = calls[0]?.payload ?? {}
  assert.equal('source_kind' in payload, false)
})

test('ensureSignalRow stamps explicit whatsapp source_kind', async () => {
  const calls: Array<{ payload: Record<string, unknown> }> = []
  const supabase = {
    from() {
      return {
        upsert(payload: Record<string, unknown>) {
          calls.push({ payload })
          return Promise.resolve({ error: null })
        },
      }
    },
  }

  const result = await ensureSignalRow(supabase as never, {
    id: '68b4b9a4-1111-2222-3333-444444444444',
    user_id: 'user-1',
    channel_id: 'wa-channel',
    source_kind: 'whatsapp',
    source_display_name: 'Signal test',
    status: 'parsed',
  })

  assert.equal(result.ok, true)
  const payload = calls[0]?.payload ?? {}
  assert.equal(payload.source_kind, 'whatsapp')
  assert.equal(payload.source_display_name, 'Signal test')
})
