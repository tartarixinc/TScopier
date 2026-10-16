import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listConflictingTelegramClaims,
  normalizeTelegramPhoneNumber,
  releaseConflictingTelegramClaims,
  restoreTelegramAccountClaims,
} from './telegramAccountClaims'

type ClaimRow = {
  user_id: string
  telegram_user_id: string | null
  phone_number_normalized: string
  linked_at?: string | null
}

type QueryState = {
  op: 'select' | 'delete' | 'insert'
  filter: { column: string; value: unknown } | null
  payload: unknown
}

/**
 * Claims double: answers `select` with the rows whose filtered column matches
 * (string-compared, the way PostgREST compares text against a bigint param),
 * and records every `delete` / `insert` so a test can assert exactly which rows
 * a takeover touched.
 */
function makeSupabase(rows: ClaimRow[], opts: { deleteError?: string } = {}) {
  const ops: QueryState[] = []

  const makeBuilder = () => {
    const state: QueryState = { op: 'select', filter: null, payload: null }
    const builder: Record<string, unknown> = {
      select: () => builder,
      delete: () => {
        state.op = 'delete'
        return builder
      },
      insert: (payload: unknown) => {
        state.op = 'insert'
        state.payload = payload
        return builder
      },
      eq: (column: string, value: unknown) => {
        state.filter = { column, value }
        return builder
      },
      in: (column: string, value: unknown) => {
        state.filter = { column, value }
        return builder
      },
      then: (resolve: (value: unknown) => void) => {
        ops.push({ ...state, filter: state.filter ? { ...state.filter } : null })
        if (state.op === 'select') {
          const filter = state.filter
          const matched = filter
            ? rows.filter(row => String((row as Record<string, unknown>)[filter.column]) === String(filter.value))
            : []
          resolve({ data: matched, error: null })
          return
        }
        if (state.op === 'delete' && opts.deleteError) {
          resolve({ data: null, error: { message: opts.deleteError } })
          return
        }
        resolve({ data: null, error: null })
      },
    }
    return builder
  }

  return {
    ops,
    from: () => makeBuilder(),
  }
}

function asClient(fake: ReturnType<typeof makeSupabase>): SupabaseClient {
  return fake as unknown as SupabaseClient
}

const selfClaim: ClaimRow = {
  user_id: 'me',
  telegram_user_id: '999',
  phone_number_normalized: '+440000000000',
  linked_at: '2026-01-01T00:00:00.000Z',
}
const phoneOwner: ClaimRow = {
  user_id: 'owner-phone',
  telegram_user_id: '111',
  phone_number_normalized: '+441111111111',
  linked_at: '2026-01-02T00:00:00.000Z',
}
const idOwner: ClaimRow = {
  user_id: 'owner-id',
  telegram_user_id: '222',
  phone_number_normalized: '+442222222222',
  linked_at: '2026-01-03T00:00:00.000Z',
}

describe('normalizeTelegramPhoneNumber', () => {
  it('strips formatting and keeps leading plus', () => {
    assert.equal(normalizeTelegramPhoneNumber('+1 (234) 567-8900'), '+12345678900')
  })

  it('converts 00 prefix to plus', () => {
    assert.equal(normalizeTelegramPhoneNumber('0044123456789'), '+44123456789')
  })
})

describe('listConflictingTelegramClaims', () => {
  it('collects the other users holding the phone number and the Telegram id', async () => {
    const fake = makeSupabase([selfClaim, phoneOwner, idOwner])
    const conflicts = await listConflictingTelegramClaims(asClient(fake), 'me', {
      phone: '+441111111111',
      telegramUserId: '222',
    })
    assert.deepEqual(conflicts.map(row => row.user_id), ['owner-phone', 'owner-id'])
    assert.equal(conflicts[0].phone_number_normalized, '+441111111111')
  })

  it('never reports the caller own claim as a conflict', async () => {
    const fake = makeSupabase([selfClaim])
    const conflicts = await listConflictingTelegramClaims(asClient(fake), 'me', {
      phone: '+440000000000',
      telegramUserId: '999',
    })
    assert.deepEqual(conflicts, [])
  })

  it('returns nothing when the phone number and id are free', async () => {
    const fake = makeSupabase([])
    const conflicts = await listConflictingTelegramClaims(asClient(fake), 'me', {
      phone: '+441111111111',
      telegramUserId: '111',
    })
    assert.deepEqual(conflicts, [])
  })

  it('propagates a database read failure instead of treating it as free', async () => {
    const fake = {
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ data: null, error: { message: 'read failed' } }),
        }),
      }),
    }
    await assert.rejects(
      () => listConflictingTelegramClaims(fake as unknown as SupabaseClient, 'me', { phone: '+441111111111' }),
      /read failed/,
    )
  })
})

describe('releaseConflictingTelegramClaims', () => {
  it('deletes exactly the conflicting rows and returns them for the audit trail', async () => {
    const fake = makeSupabase([selfClaim, phoneOwner, idOwner])
    const released = await releaseConflictingTelegramClaims(asClient(fake), 'me', {
      phone: '+441111111111',
      telegramUserId: '222',
    })
    assert.deepEqual(released.map(row => row.user_id), ['owner-phone', 'owner-id'])

    const deletes = fake.ops.filter(op => op.op === 'delete')
    assert.equal(deletes.length, 1)
    assert.deepEqual(deletes[0].filter, { column: 'user_id', value: ['owner-phone', 'owner-id'] })
  })

  it('writes nothing when the account is free', async () => {
    const fake = makeSupabase([selfClaim])
    const released = await releaseConflictingTelegramClaims(asClient(fake), 'me', {
      phone: '+440000000000',
      telegramUserId: '999',
    })
    assert.deepEqual(released, [])
    assert.equal(fake.ops.filter(op => op.op === 'delete').length, 0)
  })

  it('surfaces a delete failure so the caller can report it', async () => {
    const fake = makeSupabase([phoneOwner], { deleteError: 'delete failed' })
    await assert.rejects(
      () => releaseConflictingTelegramClaims(asClient(fake), 'me', { phone: '+441111111111' }),
      /delete failed/,
    )
  })
})

describe('restoreTelegramAccountClaims', () => {
  it('re-inserts the released rows unchanged', async () => {
    const fake = makeSupabase([])
    await restoreTelegramAccountClaims(asClient(fake), [phoneOwner])
    const inserts = fake.ops.filter(op => op.op === 'insert')
    assert.equal(inserts.length, 1)
    assert.deepEqual(inserts[0].payload, [phoneOwner])
  })

  it('writes nothing when there is nothing to restore', async () => {
    const fake = makeSupabase([])
    await restoreTelegramAccountClaims(asClient(fake), [])
    assert.equal(fake.ops.length, 0)
  })
})
