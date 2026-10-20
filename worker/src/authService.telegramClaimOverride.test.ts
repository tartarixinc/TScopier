import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AuthService } from './authService'
import { TELEGRAM_ALREADY_LINKED } from './telegramAccountClaims'

/**
 * End-to-end behaviour of the admin-only claim override, driven through the
 * real sendCode / verifyCode / finalizeAuth code paths with the Telegram client
 * and Supabase replaced by doubles.
 *
 * The invariants under test:
 *  - a normal user still gets refused with TELEGRAM_ALREADY_LINKED (unchanged),
 *  - an admin gets through and only then is the other account's claim released,
 *  - requesting a code never releases anything,
 *  - a refused non-admin never writes or deletes a claim.
 */

type ClaimRow = {
  user_id: string
  telegram_user_id: string | null
  phone_number_normalized: string
  linked_at?: string | null
}

type RecordedOp = {
  table: string
  op: 'select' | 'insert' | 'upsert' | 'delete'
  payload?: unknown
  filters: Array<[string, unknown]>
}

type EventDetail = {
  action?: string
  previous_owner_user_ids?: string[]
  admin_claim_override?: { previous_owner_user_ids: string[] }
}

const CLAIMED_PHONE = '+441111111111'
const TELEGRAM_ID = 999888777

function makeSupabase(
  claimRows: ClaimRow[],
  opts: { claimsSelectError?: string; failClaimUpsertForUserId?: string } = {},
) {
  const ops: RecordedOp[] = []

  const from = (table: string) => {
    const state = {
      op: 'select' as RecordedOp['op'],
      filters: [] as Array<[string, unknown]>,
      payload: undefined as unknown,
      maybe: false,
      single: false,
    }

    const matches = (row: Record<string, unknown>) =>
      state.filters.every(([col, value]) => String(row[col]) === String(value))

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (payload: unknown) => {
        state.op = 'insert'
        state.payload = payload
        return builder
      },
      upsert: (payload: unknown) => {
        state.op = 'upsert'
        state.payload = payload
        return builder
      },
      delete: () => {
        state.op = 'delete'
        return builder
      },
      eq: (col: string, value: unknown) => {
        state.filters.push([col, value])
        return builder
      },
      in: (col: string, value: unknown) => {
        state.filters.push([col, value])
        return builder
      },
      lt: () => builder,
      lte: () => builder,
      gt: () => builder,
      gte: () => builder,
      is: () => builder,
      not: () => builder,
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => {
        state.maybe = true
        return builder
      },
      single: () => {
        state.single = true
        return builder
      },
      then: (resolve: (value: unknown) => void) => {
        ops.push({ table, op: state.op, payload: state.payload, filters: [...state.filters] })
        const rows =
          table === 'telegram_account_claims'
            ? (claimRows as unknown as Record<string, unknown>[]).filter(matches)
            : []
        if (state.op === 'select' && table === 'telegram_account_claims' && opts.claimsSelectError) {
          resolve({ data: null, error: { message: opts.claimsSelectError } })
          return
        }
        if (
          (state.op === 'upsert' || state.op === 'insert') &&
          table === 'telegram_account_claims' &&
          opts.failClaimUpsertForUserId &&
          (state.payload as { user_id?: string } | undefined)?.user_id === opts.failClaimUpsertForUserId
        ) {
          resolve({ data: null, error: { message: 'unique violation on phone_number_normalized' } })
          return
        }
        if (state.op === 'select' && state.single) {
          resolve({ data: rows[0] ?? null, error: null })
          return
        }
        if (state.op === 'select') {
          resolve({ data: state.maybe ? (rows[0] ?? null) : rows, error: null })
          return
        }
        if (state.single) {
          resolve({ data: { id: `${table}-row` }, error: null })
          return
        }
        resolve({ data: null, error: null })
      },
    }
    return builder
  }

  return { ops, from }
}

type SupabaseDouble = ReturnType<typeof makeSupabase>

function fakeSessionManager() {
  return {
    setAuthGuard() {},
    prepareForAuth() {
      return Promise.resolve()
    },
    pauseForAuth() {
      return Promise.resolve()
    },
    adoptClient() {
      return Promise.resolve()
    },
    listChannelsForAdoptedUser() {
      return Promise.resolve([])
    },
  }
}

function fakeClient() {
  return {
    connected: true,
    session: { save: () => 'session-secret' },
    connect: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
    getMe: async () => ({ id: TELEGRAM_ID, phone: CLAIMED_PHONE.slice(1) }),
  }
}

function sendCodeDeps() {
  return {
    buildClient: () => fakeClient() as never,
    now: () => 100_000,
    invoke: async () =>
      ({
        phoneCodeHash: 'hash-a',
        className: 'auth.SentCode',
        type: { className: 'auth.SentCodeTypeApp', length: 5 },
      }) as never,
  }
}

function verifyCodeDeps() {
  return {
    buildClient: () => fakeClient() as never,
    now: () => 100_000,
    invoke: async () => ({}) as never,
  }
}

function seedPhonePending(service: AuthService, userId: string) {
  ;(service as unknown as { pending: Map<string, unknown> }).pending.set(userId, {
    method: 'phone',
    client: fakeClient(),
    phone: CLAIMED_PHONE,
    phoneCodeHash: 'hash-a',
    delivery: 'app',
    nextDelivery: null,
    timeoutSeconds: null,
    resendAvailableAt: null,
    canResend: false,
    codeLength: 5,
    createdAt: Date.now() - 60_000,
    awaitingPassword: false,
  })
}

function claimedRow(): ClaimRow {
  return {
    user_id: 'owner-1',
    telegram_user_id: '555111222',
    phone_number_normalized: CLAIMED_PHONE,
    linked_at: '2026-01-01T00:00:00.000Z',
  }
}

const services: AuthService[] = []
function makeService(supabase: SupabaseDouble, deps: ReturnType<typeof sendCodeDeps>) {
  const service = new AuthService(supabase as never, fakeSessionManager() as never, deps)
  services.push(service)
  return service
}

afterEach(async () => {
  const open = services.splice(0, services.length)
  await Promise.all(open.map(service => service.shutdown()))
  delete process.env.TSCOPIER_ADMIN_USER_IDS
})

function claimOps(supabase: SupabaseDouble) {
  return supabase.ops.filter(op => op.table === 'telegram_account_claims')
}

function listenerEvents(supabase: SupabaseDouble) {
  return supabase.ops.filter(
    op => op.table === 'listener_events' && op.op === 'insert',
  )
}

describe('admin Telegram claim override', () => {
  it('still refuses a normal user whose phone number is already linked', async () => {
    const supabase = makeSupabase([claimedRow()])
    const service = makeService(supabase, sendCodeDeps())

    await assert.rejects(
      () => service.sendCode('user-normal', CLAIMED_PHONE),
      (err: Error) => err.message === TELEGRAM_ALREADY_LINKED,
    )
    assert.equal(
      claimOps(supabase).filter(op => op.op === 'delete').length,
      0,
      'a refused request must not release anyone',
    )
  })

  it('lets an admin request a code without releasing the other account', async () => {
    // Each test uses its own admin id: loadCachedUserIsAdmin caches for 60s.
    process.env.TSCOPIER_ADMIN_USER_IDS = 'admin-a'
    const supabase = makeSupabase([claimedRow()])
    const service = makeService(supabase, sendCodeDeps())

    const status = await service.sendCode('admin-a', CLAIMED_PHONE)
    assert.equal(status.delivery, 'app')

    const deletes = claimOps(supabase).filter(op => op.op === 'delete')
    assert.deepEqual(deletes, [], 'requesting a code must never unbind anyone')
    assert.equal(
      listenerEvents(supabase).length,
      0,
      'a code request records no link outcome yet',
    )
  })

  it('releases the claim only when the admin login completes, and records it', async () => {
    process.env.TSCOPIER_ADMIN_USER_IDS = 'admin-b'
    const supabase = makeSupabase([claimedRow()])
    const service = makeService(supabase, verifyCodeDeps())
    seedPhonePending(service, 'admin-b')

    const result = (await service.verifyCode('admin-b', CLAIMED_PHONE, '12345')) as {
      ok?: boolean
      session_id?: string
    }
    assert.equal(result.ok, true)
    assert.equal(result.session_id, 'telegram_sessions-row')

    const deletes = claimOps(supabase).filter(op => op.op === 'delete')
    assert.equal(deletes.length, 1, 'the conflicting claim is released exactly once')
    assert.deepEqual(deletes[0].filters, [['user_id', ['owner-1']]])

    const claims = claimOps(supabase).filter(op => op.op === 'upsert')
    assert.equal(claims.length, 1)
    assert.equal((claims[0].payload as { user_id: string }).user_id, 'admin-b')

    assert.equal(
      supabase.ops.filter(op => op.table === 'telegram_sessions' && op.op === 'delete').length,
      0,
      'Option 1: the other account keeps its session and is never disconnected',
    )

    const events = listenerEvents(supabase)
    const details = events.map(op => (op.payload as { detail?: EventDetail }).detail ?? {})
    const releasedIndex = details.findIndex(detail => detail.action === 'admin_claim_override_released')
    const successIndex = details.findIndex(detail => detail.admin_claim_override)
    assert.ok(releasedIndex >= 0, 'the takeover is recorded before the claim is written')
    assert.deepEqual(details[releasedIndex]?.previous_owner_user_ids, ['owner-1'])
    assert.ok(successIndex >= 0, 'the successful link carries the takeover detail')
    assert.deepEqual(details[successIndex]?.admin_claim_override?.previous_owner_user_ids, ['owner-1'])
    assert.ok(
      releasedIndex < successIndex,
      'the release record must exist even if the process dies before success',
    )
  })

  it('never releases anything for a non-admin who finishes the login', async () => {
    const supabase = makeSupabase([claimedRow()])
    const service = makeService(supabase, verifyCodeDeps())
    seedPhonePending(service, 'user-normal')

    await assert.rejects(
      () => service.verifyCode('user-normal', CLAIMED_PHONE, '12345'),
      (err: Error) => err.message === TELEGRAM_ALREADY_LINKED,
    )
    assert.equal(
      claimOps(supabase).filter(op => op.op !== 'select').length,
      0,
      'a refused non-admin must not write or delete any claim',
    )
  })

  it('never waves a database problem through, even for an admin', async () => {
    process.env.TSCOPIER_ADMIN_USER_IDS = 'admin-c'
    const supabase = makeSupabase([claimedRow()], { claimsSelectError: 'read failed' })
    const service = makeService(supabase, sendCodeDeps())

    await assert.rejects(
      () => service.sendCode('admin-c', CLAIMED_PHONE),
      (err: Error) => err.message === 'read failed',
      'a database failure must surface as itself, never as a permitted link',
    )
    assert.equal(
      claimOps(supabase).filter(op => op.op === 'delete').length,
      0,
      'nothing may be released when the claim could not even be read',
    )
  })

  it('restores the released claim and drops the session when the claim write fails', async () => {
    process.env.TSCOPIER_ADMIN_USER_IDS = 'admin-d'
    const supabase = makeSupabase([claimedRow()], { failClaimUpsertForUserId: 'admin-d' })
    const service = makeService(supabase, verifyCodeDeps())
    seedPhonePending(service, 'admin-d')

    await assert.rejects(
      () => service.verifyCode('admin-d', CLAIMED_PHONE, '12345'),
      (err: Error) => /unique violation/.test(err.message),
    )

    assert.equal(
      claimOps(supabase).filter(op => op.op === 'delete').length,
      1,
      'the release happened before the failed write',
    )

    const restores = claimOps(supabase).filter(op => op.op === 'insert')
    assert.equal(restores.length, 1, 'the released claim is put back')
    assert.equal(
      (restores[0].payload as Array<{ user_id: string }>)[0]?.user_id,
      'owner-1',
    )

    assert.equal(
      supabase.ops.filter(op => op.table === 'telegram_sessions' && op.op === 'delete').length,
      1,
      'the failed link leaves no session row behind',
    )
  })
})
