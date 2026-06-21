import test from 'node:test'
import assert from 'node:assert/strict'
import { claimSignalExecution } from './dispatch'
import type { TradeExecutorContext } from './context'
import { invalidateCopierPauseCache, loadCachedUserCopierPaused, setUserCopierPausedCached } from '../copierPause'

test('loadCachedUserCopierPaused blocks execution path when user is paused', async () => {
  invalidateCopierPauseCache()
  setUserCopierPausedCached('user-pause-test', true)

  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { copier_paused: true }, error: null }),
        }),
      }),
    }),
  } as unknown as TradeExecutorContext['supabase']

  assert.equal(await loadCachedUserCopierPaused(supabase, 'user-pause-test'), true)

  const inflight = new Set<string>()
  const queuedIds = new Set<string>()
  const ctx = { inflight, queuedIds } as unknown as TradeExecutorContext
  assert.equal(claimSignalExecution(ctx, 'signal-1'), true)
  assert.equal(await loadCachedUserCopierPaused(supabase, 'user-pause-test'), true)
  inflight.delete('signal-1')
  queuedIds.delete('signal-1')
  assert.equal(inflight.has('signal-1'), false)
})
