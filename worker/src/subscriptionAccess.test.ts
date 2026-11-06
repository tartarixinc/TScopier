import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { invalidateCopierPauseCache, setUserCopierPausedCached } from './copierPause'
import {
  extensionAccessActive,
  subscriptionBlocksSignalExecution,
  userMayRunCopierListener,
  type UserSubscriptionRow,
} from './subscriptionAccess'

test('userMayRunCopierListener: active subscription allows listener even when copier paused', async () => {
  setUserCopierPausedCached('user-active-paused', true)
  const supabase = {
    from(table: string) {
      if (table === 'user_profiles') {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: { is_admin: false, admin_until: null }, error: null }) }
              },
            }
          },
        }
      }
      if (table === 'subscriptions') {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: { plan: 'basic', status: 'active', extra_accounts: 0, trial_ends_at: null },
                    error: null,
                  }),
                }
              },
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    auth: { admin: { getUserById: async () => ({ data: null, error: null }) } },
  }

  const allowed = await userMayRunCopierListener(supabase as never, 'user-active-paused')
  assert.equal(allowed, true)
  invalidateCopierPauseCache('user-active-paused')
})

test('userMayRunCopierListener: inactive subscription blocks listener', async () => {
  const supabase = {
    from(table: string) {
      if (table === 'user_profiles') {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: { is_admin: false, admin_until: null }, error: null }) }
              },
            }
          },
        }
      }
      if (table === 'subscriptions') {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: { plan: 'basic', status: 'canceled', extra_accounts: 0, trial_ends_at: null },
                    error: null,
                  }),
                }
              },
            }
          },
        }
      }
      if (table === 'subscription_extensions') {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return { limit: async () => ({ data: [], error: null }) }
                  },
                }
              },
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    auth: { admin: { getUserById: async () => ({ data: null, error: null }) } },
  }

  const allowed = await userMayRunCopierListener(supabase as never, 'user-inactive')
  assert.equal(allowed, false)
})

test('userMayRunCopierListener: a live admin extension allows the listener again', async () => {
  const supabase = {
    from(table: string) {
      if (table === 'user_profiles') {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: { is_admin: false, admin_until: null }, error: null }) }
              },
            }
          },
        }
      }
      if (table === 'subscriptions') {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: { plan: 'basic', status: 'canceled', extra_accounts: 0, trial_ends_at: null },
                    error: null,
                  }),
                }
              },
            }
          },
        }
      }
      if (table === 'subscription_extensions') {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return {
                      limit: async () => ({
                        data: [{ days: 14, granted_at: new Date(Date.now() - 86_400_000).toISOString() }],
                        error: null,
                      }),
                    }
                  },
                }
              },
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
    auth: { admin: { getUserById: async () => ({ data: null, error: null }) } },
  }

  const allowed = await userMayRunCopierListener(supabase as never, 'user-granted')
  assert.equal(allowed, true)
})

const DAY = 86_400_000
const future = Date.now() + 7 * DAY
const past = Date.now() - DAY

const basic: UserSubscriptionRow = {
  plan: 'basic',
  status: 'trialing',
  extra_accounts: 0,
  trial_ends_at: new Date(Date.now() - DAY).toISOString(),
}
const advanced: UserSubscriptionRow = { ...basic, plan: 'advanced' }
const advancedSettings = { range_trading: true } as Record<string, unknown>
const basicSettings = {} as Record<string, unknown>

test('admin always passes', () => {
  assert.equal(subscriptionBlocksSignalExecution(null, advancedSettings, true, null), null)
})

test('expired trial with no extension is blocked', () => {
  assert.equal(
    subscriptionBlocksSignalExecution(basic, basicSettings, false, null),
    'subscription_inactive',
  )
  assert.equal(
    subscriptionBlocksSignalExecution(basic, basicSettings, false, past),
    'subscription_inactive',
  )
})

test('expired trial with a live extension keeps running', () => {
  assert.equal(subscriptionBlocksSignalExecution(basic, basicSettings, false, future), null)
})

test('a live extension keeps plan limits: basic cannot use advanced features', () => {
  assert.equal(
    subscriptionBlocksSignalExecution(basic, advancedSettings, false, future),
    'plan_advanced_feature_required',
  )
})

test('a live extension keeps plan limits: advanced keeps advanced features', () => {
  assert.equal(
    subscriptionBlocksSignalExecution(advanced, advancedSettings, false, future),
    null,
  )
})

test('a user with no subscription row passes only with a live extension', () => {
  assert.equal(subscriptionBlocksSignalExecution(null, basicSettings, false, future), null)
  assert.equal(
    subscriptionBlocksSignalExecution(null, advancedSettings, false, future),
    'plan_advanced_feature_required',
  )
  assert.equal(subscriptionBlocksSignalExecution(null, basicSettings, false, null), 'subscription_inactive')
})

test('extensionAccessActive treats the end moment as expired', () => {
  assert.equal(extensionAccessActive(null), false)
  assert.equal(extensionAccessActive(future), true)
  assert.equal(extensionAccessActive(past), false)
  assert.equal(extensionAccessActive(Date.now(), Date.now()), false)
})
