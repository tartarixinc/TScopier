import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UserSessionManager } from './sessionManager'
import type { UserListener } from './userListener'
import type { SupabaseClient } from '@supabase/supabase-js'

type RpcCall = { name: string; args: Record<string, unknown> }

/**
 * Minimal supabase double: records every `rpc` call (health writes) and every
 * table touch, and answers reads with a null/empty payload. `disconnectListener`
 * and `renewOneListenerLease` are the paths under test — both are pure writes
 * plus lease bookkeeping, so nothing here needs real data beyond "no pending
 * auth" and "the lease op finished".
 */
function makeSupabase() {
  const calls: Array<{ table: string; op: string }> = []
  const rpcCalls: RpcCall[] = []
  const builder = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      insert: () => b,
      upsert: () => b,
      update: () => b,
      delete: () => b,
      eq: () => b,
      neq: () => b,
      gt: () => b,
      lt: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        calls.push({ table, op: 'maybeSingle' })
        return Promise.resolve({ data: null, error: null })
      },
      single: () => {
        calls.push({ table, op: 'single' })
        return Promise.resolve({ data: null, error: null })
      },
      then: (resolve: (v: unknown) => void) => {
        calls.push({ table, op: 'await' })
        resolve({ data: null, error: null })
      },
    }
    return b
  }
  return {
    calls,
    rpcCalls,
    from: (table: string) => {
      return new Proxy(builder(table), {
        get: (target, prop, receiver) => {
          if (typeof prop === 'string') {
            calls.push({ table, op: prop })
          }
          return Reflect.get(target, prop, receiver)
        },
      })
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return { data: true, error: null }
    },
    removeChannel: async () => {},
    auth: { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } },
  }
}

type Internal = {
  listeners: Map<string, UserListener>
  disconnectedRenewTicks: Map<string, number>
  disconnectListener(userId: string): Promise<void>
  renewOneListenerLease(
    userId: string,
    listener: UserListener,
    opts: { staleMs: number; perUserTimeoutMs: number },
  ): Promise<void>
}

function makeListener(opts: { revoked: boolean; userId: string }) {
  const state = {
    stopped: 0,
    reconnectKicked: [] as string[],
  }
  const listener = {
    isSessionRevoked: () => opts.revoked,
    isTelegramConnected: () => false,
    isListenerHealthy: () => false,
    requestReconnectIfDisconnected: (reason: string) => { state.reconnectKicked.push(reason) },
    stop: async () => { state.stopped += 1 },
    getHealthOwnershipEpoch: () => 'epoch-1',
    getHealthLeaseAcquiredAt: () => '2026-09-30T00:00:00.000Z',
  }
  return { listener: listener as unknown as UserListener, state }
}

function healthWrites(supabase: ReturnType<typeof makeSupabase>) {
  return supabase.rpcCalls.filter(c => c.name === 'upsert_copier_listener_health')
}

describe('sessionManager revoked-session health writes', () => {
  it('writes reconnect_required and recovery_exhausted when stopping a revoked listener', async () => {
    const supabase = makeSupabase()
    const manager = new UserSessionManager(supabase as unknown as SupabaseClient)
    const internal = manager as unknown as Internal
    const { listener } = makeListener({ revoked: true, userId: 'user-revoked-stop' })
    internal.listeners.set('user-revoked-stop', listener)

    await internal.disconnectListener('user-revoked-stop')

    // Pre-fix behaviour: both writes hard-coded telegram_account_status
    // 'linked' and left recovery_exhausted unset, so the re-link banner written
    // by the listener a moment earlier was overwritten on the very next stop
    // (the two columns are overwritten on every upsert).
    const writes = healthWrites(supabase)
    assert.equal(writes.length, 2, 'stop must write health before and after the lease release')
    assert.equal(writes[0].args.p_telegram_account_status, 'reconnect_required')
    assert.equal(writes[0].args.p_recovery_exhausted, true)
    assert.equal(writes[0].args.p_allow_without_lease, true)
    assert.equal(writes[0].args.p_require_lease, false)
    assert.equal(writes[0].args.p_shutdown_in_progress, true)
    assert.equal(writes[1].args.p_telegram_account_status, 'reconnect_required')
    assert.equal(writes[1].args.p_recovery_exhausted, true)
    assert.equal(writes[1].args.p_worker_ownership_status, 'unowned')
    assert.equal(writes[1].args.p_shutdown_in_progress, false)
    assert.equal(internal.listeners.size, 0, 'the listener must still be removed from the map')
  })

  it('keeps a healthy listener linked and not exhausted on stop', async () => {
    const supabase = makeSupabase()
    const manager = new UserSessionManager(supabase as unknown as SupabaseClient)
    const internal = manager as unknown as Internal
    const { listener } = makeListener({ revoked: false, userId: 'user-healthy-stop' })
    internal.listeners.set('user-healthy-stop', listener)

    await internal.disconnectListener('user-healthy-stop')

    const writes = healthWrites(supabase)
    assert.equal(writes.length, 2)
    assert.equal(writes[0].args.p_telegram_account_status, 'linked')
    assert.equal(writes[0].args.p_recovery_exhausted, false)
    // A healthy stop still goes through the lease check.
    assert.equal(writes[0].args.p_require_lease, true)
    assert.equal(writes[0].args.p_allow_without_lease, false)
    assert.equal(writes[1].args.p_telegram_account_status, 'linked')
    assert.equal(writes[1].args.p_recovery_exhausted, false)
  })

  it('parks a revoked listener on lease renew instead of stopping or reconnecting it', async () => {
    const adminUserId = 'user-revoked-renew'
    // userMayRunCopierListener short-circuits on this env list, so the renew
    // path never needs a subscriptions row to reach the parked branch.
    process.env.TSCOPIER_ADMIN_USER_IDS = adminUserId
    try {
      const supabase = makeSupabase()
      const manager = new UserSessionManager(supabase as unknown as SupabaseClient)
      const internal = manager as unknown as Internal
      const { listener, state } = makeListener({ revoked: true, userId: adminUserId })
      internal.listeners.set(adminUserId, listener)
      internal.disconnectedRenewTicks.set(adminUserId, 3)

      await internal.renewOneListenerLease(adminUserId, listener, {
        staleMs: 120_000,
        perUserTimeoutMs: 1_000,
      })

      assert.equal(state.stopped, 0, 'a revoked listener must not be stopped (that restarted the heal cycle)')
      assert.deepEqual(state.reconnectKicked, [], 'a revoked listener must not be reconnected')
      assert.equal(
        internal.disconnectedRenewTicks.has(adminUserId),
        false,
        'the disconnect counter must be cleared so it never reaches the hard-reset threshold',
      )
      assert.equal(
        internal.listeners.has(adminUserId),
        true,
        'the listener must stay parked in the map until the user re-links',
      )
    } finally {
      delete process.env.TSCOPIER_ADMIN_USER_IDS
    }
  })
})
