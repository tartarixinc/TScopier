import test from 'node:test'
import assert from 'node:assert/strict'
import {
  invalidateCopierPauseCache,
  isUserCopierPausedCached,
  loadCachedUserCopierPaused,
  primeCopierPauseCache,
  setUserCopierPausedCached,
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
