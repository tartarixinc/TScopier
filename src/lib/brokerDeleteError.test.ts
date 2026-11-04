import { describe, expect, it } from 'vitest'
import { friendlyBrokerDeleteError } from './brokerDeleteError'

describe('friendlyBrokerDeleteError', () => {
  it('explains a published provider account', () => {
    const raw = 'update or delete on table "broker_accounts" violates foreign key constraint "social_copy_sources_broker_account_id_fkey" on table "social_copy_sources"'
    const text = friendlyBrokerDeleteError(raw)
    expect(text).toContain('published provider account')
    expect(text).not.toContain('constraint')
  })

  it('explains an account that is copying a provider', () => {
    const raw = 'update or delete on table "broker_accounts" violates foreign key constraint "social_copy_subscriptions_destination_broker_account_id_fkey" on table "social_copy_subscriptions"'
    expect(friendlyBrokerDeleteError(raw)).toContain('copying a provider')
  })

  it('falls back to a generic message for other foreign keys', () => {
    expect(friendlyBrokerDeleteError('violates foreign key constraint "x_fkey" on table "x"')).toContain('still linked')
  })

  it('leaves unrelated errors untouched', () => {
    expect(friendlyBrokerDeleteError('Unauthorized')).toBe('Unauthorized')
  })
})
