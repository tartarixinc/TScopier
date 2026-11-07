import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchSocialCopyAttribution, parseSocialCopyComment } from './socialCopyAttribution'

const SUB_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'

describe('parseSocialCopyComment', () => {
  it('parses the worker comment format sc:<subscription8>:<ticket>', () => {
    expect(parseSocialCopyComment('sc:aaaaaaaa:547044465')).toEqual({
      subscriptionPrefix: 'aaaaaaaa',
      sourceTicket: '547044465',
    })
  })

  it('accepts uppercase hex and trims whitespace', () => {
    expect(parseSocialCopyComment('  sc:ABCDEF12:42 ')).toEqual({
      subscriptionPrefix: 'abcdef12',
      sourceTicket: '42',
    })
  })

  it('rejects mirror comments, signal comments, and truncated prefixes', () => {
    expect(parseSocialCopyComment('mc:bbbbbbbb:99')).toBeNull()
    expect(parseSocialCopyComment('TScopier:GOLD:34dcf76d')).toBeNull()
    expect(parseSocialCopyComment('sc:short:42')).toBeNull()
    expect(parseSocialCopyComment('sc:aaaaaaaa')).toBeNull()
    expect(parseSocialCopyComment('')).toBeNull()
    expect(parseSocialCopyComment(null)).toBeNull()
  })
})

function fakeSupabase(opts: {
  subscriptions?: unknown
  mappings?: unknown
  directory?: unknown
}): SupabaseClient {
  return {
    from(table: string) {
      const result =
        table === 'social_copy_subscriptions'
          ? { data: opts.subscriptions ?? [], error: null }
          : { data: opts.mappings ?? null, error: null }
      const api: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'in', 'limit']) {
        api[method] = () => api
      }
      api.maybeSingle = async () => {
        if (Array.isArray(result.data)) {
          return { data: result.data[0] ?? null, error: null }
        }
        return result
      }
      api.then = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject)
      return api
    },
    rpc() {
      return Promise.resolve({ data: opts.directory ?? [], error: null })
    },
  } as unknown as SupabaseClient
}

describe('fetchSocialCopyAttribution', () => {
  it('resolves the provider through the sc: comment', async () => {
    const client = fakeSupabase({
      subscriptions: [{ id: SUB_ID, source_trader_user_id: 'trader-1' }],
      mappings: {
        id: 'map-1',
        subscription_id: SUB_ID,
        source_ticket: '99',
        state: 'open',
        destination_ticket: '100',
        broker_comment: 'sc:aaaaaaaa:99',
      },
      directory: [{ profile_user_id: 'trader-1', display_name: 'Amina' }],
    })
    expect(await fetchSocialCopyAttribution(client, 'user-1', 'sc:aaaaaaaa:99')).toEqual({
      providerName: 'Amina',
      sourceTicket: '99',
      subscriptionId: SUB_ID,
      mappingId: 'map-1',
      mappingState: 'open',
    })
  })

  it('falls back to destination ticket when the comment is missing', async () => {
    const client = fakeSupabase({
      subscriptions: [{ id: SUB_ID, source_trader_user_id: 'trader-1' }],
      mappings: [{
        id: 'map-2',
        subscription_id: SUB_ID,
        source_ticket: '55',
        state: 'open',
        destination_ticket: '3442375631',
        broker_comment: 'sc:aaaaaaaa:55',
      }],
      directory: [{ profile_user_id: 'trader-1', display_name: 'Amina' }],
    })
    expect(await fetchSocialCopyAttribution(client, 'user-1', null, '3442375631')).toEqual({
      providerName: 'Amina',
      sourceTicket: '55',
      subscriptionId: SUB_ID,
      mappingId: 'map-2',
      mappingState: 'open',
    })
  })

  it('returns null when the user has no social subscriptions', async () => {
    const client = fakeSupabase({ subscriptions: [] })
    expect(await fetchSocialCopyAttribution(client, 'user-1', 'sc:aaaaaaaa:99')).toBeNull()
  })
})
