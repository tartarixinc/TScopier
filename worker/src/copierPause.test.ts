import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCopierPauseProfileUpdate,
  getCopierResumedAt,
  invalidateCopierPauseCache,
  isUserCopierPausedCached,
  loadCachedUserCopierPaused,
  noteCopierResumed,
  primeCopierPauseCache,
  setUserCopierPausedCached,
  signalPredatesCopierResume,
} from './copierPause'

test('copierPause cache stores and reads paused state', () => {
  invalidateCopierPauseCache()
  assert.equal(isUserCopierPausedCached('user-a'), false)
  setUserCopierPausedCached('user-a', true)
  assert.equal(isUserCopierPausedCached('user-a'), true)
  invalidateCopierPauseCache('user-a')
  assert.equal(isUserCopierPausedCached('user-a'), false)
})

test('primeCopierPauseCache loads batch profile rows', () => {
  invalidateCopierPauseCache()
  primeCopierPauseCache([
    { user_id: 'user-b', copier_paused: true },
    { user_id: 'user-c', copier_paused: false },
  ])
  assert.equal(isUserCopierPausedCached('user-b'), true)
  assert.equal(isUserCopierPausedCached('user-c'), false)
})

test('loadCachedUserCopierPaused reads from supabase when cache cold', async () => {
  invalidateCopierPauseCache()
  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { copier_paused: true }, error: null }),
        }),
      }),
    }),
  }
  const paused = await loadCachedUserCopierPaused(supabase as never, 'user-d')
  assert.equal(paused, true)
  assert.equal(isUserCopierPausedCached('user-d'), true)
})

test('applyCopierPauseProfileUpdate records resume time for stale-signal gate', () => {
  invalidateCopierPauseCache()
  assert.equal(applyCopierPauseProfileUpdate('user-e', true, false), 'paused')
  assert.equal(isUserCopierPausedCached('user-e'), true)
  assert.equal(getCopierResumedAt('user-e'), null)

  const beforeResume = Date.now()
  assert.equal(applyCopierPauseProfileUpdate('user-e', false, true), 'resumed')
  const resumedAt = getCopierResumedAt('user-e')
  assert.ok(resumedAt != null && resumedAt >= beforeResume)
  assert.equal(isUserCopierPausedCached('user-e'), false)
})

test('signalPredatesCopierResume ignores signals created before resume', () => {
  invalidateCopierPauseCache()
  noteCopierResumed('user-f')
  const resumedAt = getCopierResumedAt('user-f')!
  const beforeResume = new Date(resumedAt - 60_000).toISOString()
  const afterResume = new Date(resumedAt + 60_000).toISOString()

  assert.equal(signalPredatesCopierResume('user-f', beforeResume), true)
  assert.equal(signalPredatesCopierResume('user-f', afterResume), false)
  assert.equal(signalPredatesCopierResume('user-g', beforeResume), false)
})
