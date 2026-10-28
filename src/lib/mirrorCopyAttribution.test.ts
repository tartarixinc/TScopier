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

type Handler = (table: string, columns: string) => { data: unknown; error: { code?: string; message?: string } | null }

function fakeSupabase(handler: Handler): SupabaseClient {
  const run = (table: string, columns: string) => ({
    eq() {
      return {
        eq() {
          return {
            maybeSingle: async () => handler(table, columns),
            then(resolve: (v: { data: unknown; error: null }) => unknown) {
              return Promise.resolve(handler(table, columns)).then(resolve)
            },
          }
        },
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve(handler(table, columns)).then(resolve)
        },
      }
    },
  })
  return {
    from(table: string) {
      return {
        select(columns?: string) {
          return run(table, columns ?? '')
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
          ? { data: { id: 'map-1', state: 'open', close_reason: null }, error: null }
          : { data: { account_login: '476205231' }, error: null },
    )
    expect(await fetchMirrorCopyAttribution(client, 'user-1', 'mc:bbbbbbbb:99')).toEqual({
      masterLogin: '476205231',
      sourceTicket: '99',
      mappingId: 'map-1',
      mappingState: 'open',
      mappingCloseReason: null,
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
      mappingCloseReason: null,
    })
  })

  it('returns the stored close reason for a closed copy', async () => {
    const client = fakeSupabase(table =>
      table === 'broker_copy_links'
        ? { data: [{ id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', source_broker_account_id: 'src-1' }], error: null }
        : table === 'mirror_copy_trade_mappings'
          ? { data: { id: 'map-1', state: 'closed', close_reason: 'user_force_close' }, error: null }
          : { data: { account_login: '476205231' }, error: null },
    )
    expect(await fetchMirrorCopyAttribution(client, 'user-1', 'mc:bbbbbbbb:99')).toEqual({
      masterLogin: '476205231',
      sourceTicket: '99',
      mappingId: 'map-1',
      mappingState: 'closed',
      mappingCloseReason: 'user_force_close',
    })
  })

  it('retries without close_reason when the column is not deployed yet', async () => {
    const client = fakeSupabase((table, columns) => {
      if (table === 'broker_copy_links') {
        return { data: [{ id: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb', source_broker_account_id: 'src-1' }], error: null }
      }
      if (table === 'mirror_copy_trade_mappings') {
        return columns.includes('close_reason')
          ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'close_reason' column" } }
          : { data: { id: 'map-1', state: 'closed' }, error: null }
      }
      return { data: { account_login: '476205231' }, error: null }
    })
    expect(await fetchMirrorCopyAttribution(client, 'user-1', 'mc:bbbbbbbb:99')).toEqual({
      masterLogin: '476205231',
      sourceTicket: '99',
      mappingId: 'map-1',
      mappingState: 'closed',
      mappingCloseReason: null,
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
          ? { data: { id: 'map-1', state: 'open', close_reason: null }, error: null }
          : { data: { account_login: '' }, error: null },
    )
    expect(await fetchMirrorCopyAttribution(noLogin, 'user-1', 'mc:bbbbbbbb:1')).toBeNull()
  })
})
