import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMirrorCopyAttribution, parseMirrorCopyComment } from './mirrorCopyAttribution'

describe('parseMirrorCopyComment', () => {
  it('parses the worker comment format mc:<link8>:<ticket>', () => {
    expect(parseMirrorCopyComment('mc:bbbbbbbb:3389489202')).toEqual({
      linkPrefix: 'bbbbbbbb',
      sourceTicket: '3389489202',
    })
  })

  it('accepts uppercase hex and trims whitespace', () => {
    expect(parseMirrorCopyComment('  mc:ABCDEF12:42 ')).toEqual({
      linkPrefix: 'abcdef12',
      sourceTicket: '42',
    })
  })

  it('rejects signal comments, empty values, and truncated prefixes', () => {
    expect(parseMirrorCopyComment('TScopier:GOLDXAUUSDBT:34dcf76d')).toBeNull()
    expect(parseMirrorCopyComment('mc:short:42')).toBeNull()
    expect(parseMirrorCopyComment('mc:bbbbbbbb')).toBeNull()
    expect(parseMirrorCopyComment('')).toBeNull()
    expect(parseMirrorCopyComment(null)).toBeNull()
    expect(parseMirrorCopyComment(undefined)).toBeNull()
  })
})

type Handler = (table: string) => { data: unknown; error: null }

function fakeSupabase(handler: Handler): SupabaseClient {
  const run = (table: string) => ({
    eq() {
      return {
        eq() {
          return {
            maybeSingle: async () => handler(table),
            then(resolve: (v: { data: unknown; error: null }) => unknown) {
              return Promise.resolve(handler(table)).then(resolve)
            },
          }
        },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve(handler(table)).then(resolve)
        },
      }
    },
  })
  return {
    from(table: string) {
      return {
        select() {
          return run(table)
        },
      }
    },
  } as unknown as SupabaseClient
}

describe('fetchMirrorCopyAttribution', () => {
  it('resolves the master login and the ledger mapping through the link prefix', async () => {
    const client = fakeSupabase(table =>
      table === 'broker_copy_links'
        ? { data: [{ id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', source_broker_account_id: 'src-1' }], error: null }
        : table === 'mirror_copy_trade_mappings'
          ? { data: { id: 'map-1', state: 'open' }, error: null }
          : { data: { account_login: '476205231' }, error: null },
    )
    expect(await fetchMirrorCopyAttribution(client, 'user-1', 'mc:bbbbbbbb:99')).toEqual({
      masterLogin: '476205231',
      sourceTicket: '99',
      mappingId: 'map-1',
      mappingState: 'open',
    })
  })

  it('degrades to a null mapping when the ledger read fails or finds nothing', async () => {
    const noMapping = fakeSupabase(table =>
      table === 'broker_copy_links'
        ? { data: [{ id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', source_broker_account_id: 'src-1' }], error: null }
        : table === 'mirror_copy_trade_mappings'
          ? { data: null, error: null }
          : { data: { account_login: '476205231' }, error: null },
    )
    expect(await fetchMirrorCopyAttribution(noMapping, 'user-1', 'mc:bbbbbbbb:99')).toEqual({
      masterLogin: '476205231',
      sourceTicket: '99',
      mappingId: null,
      mappingState: null,
    })
  })

  it('returns null when no comment, no matching link, or no login', async () => {
    const noMatch = fakeSupabase(() => ({ data: [], error: null }))
    expect(await fetchMirrorCopyAttribution(noMatch, 'user-1', 'mc:ffffffff:1')).toBeNull()
    expect(await fetchMirrorCopyAttribution(noMatch, 'user-1', 'TScopier:x:1')).toBeNull()

    const noLogin = fakeSupabase(table =>
      table === 'broker_copy_links'
        ? { data: [{ id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', source_broker_account_id: 'src-1' }], error: null }
        : table === 'mirror_copy_trade_mappings'
          ? { data: { id: 'map-1', state: 'open' }, error: null }
          : { data: { account_login: '' }, error: null },
    )
    expect(await fetchMirrorCopyAttribution(noLogin, 'user-1', 'mc:bbbbbbbb:1')).toBeNull()
  })
})
