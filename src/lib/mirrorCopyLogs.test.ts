import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMirrorCopyLogs, normalizeMirrorCopyLogs, pageMirrorSlice, type MirrorCopyLogRow } from './mirrorCopyLogs'

function mirrorAt(createdAt: string): MirrorCopyLogRow {
  return {
    id: `m-${createdAt}`,
    createdAt,
    status: 'executed',
    action: 'open',
    side: 'buy',
    symbol: 'BTCUSDm',
    sourceTicket: '1',
    lot: 0.01,
    channelName: 'MT5 • 476205231',
    destinationAccount: 'MT5 • 477608729',
    destinationTicket: '2',
    reason: null,
  }
}

const signalAt = (created_at: string) => ({ created_at })

describe('pageMirrorSlice', () => {
  const at = (time: string) => `2026-10-25T${time}:00Z`
  const mirrors = ['12:08', '11:00', '10:30', '09:00', '08:45', '07:30', '06:10'].map(t => mirrorAt(at(t)))
  const signalPair = (newest: string, oldest: string) => [signalAt(at(newest)), signalAt(at(oldest))]

  it('keeps page 1 events both above its newest signal and inside its own span', () => {
    // The gap this guards: 11:00 and 10:30 sit between page 1's signals, and no
    // later page reaches above the previous page's oldest signal — so an
    // upper-bounded page 1 would strand them on no page at all.
    const rows = pageMirrorSlice(mirrors, signalPair('11:30', '09:30'), 1, null)
    expect(rows.map(r => r.createdAt)).toEqual([at('12:08'), at('11:00'), at('10:30')])
  })

  it('places every event on exactly one page in a sequential walk', () => {
    const page1 = pageMirrorSlice(mirrors, signalPair('11:30', '09:30'), 1, null)
    const page2 = pageMirrorSlice(mirrors, signalPair('09:30', '08:00'), 2, at('09:30'))
    const page3 = pageMirrorSlice(mirrors, signalPair('08:00', '07:00'), 3, at('08:00'), true)

    expect(page1.map(r => r.createdAt)).toEqual([at('12:08'), at('11:00'), at('10:30')])
    expect(page2.map(r => r.createdAt)).toEqual([at('09:00'), at('08:45')])
    expect(page3.map(r => r.createdAt)).toEqual([at('07:30'), at('06:10')])

    const shown = [...page1, ...page2, ...page3].map(r => r.createdAt).sort()
    expect(shown).toEqual(mirrors.map(m => m.createdAt).sort())
  })

  it('absorbs events older than every signal on the last signal page', () => {
    const rows = pageMirrorSlice(mirrors, signalPair('08:00', '07:00'), 3, at('08:00'), true)
    expect(rows.map(r => r.createdAt)).toEqual([at('07:30'), at('06:10')])
  })

  it('falls back to the page own span after a jump, so rows still appear', () => {
    const rows = pageMirrorSlice(mirrors, signalPair('11:30', '10:00'), 9, null)
    expect(rows.map(r => r.createdAt)).toEqual([at('11:00'), at('10:30')])
  })

  it('shows every event of a dense window instead of dropping the oldest', () => {
    // No per-page cap: a dropped event would sit above the next page's bound
    // (its signal) and could never be shown again.
    const burst = Array.from({ length: 30 }, (_, i) => mirrorAt(at(`12:${String(i).padStart(2, '0')}`)))
    expect(pageMirrorSlice(burst, signalPair('11:30', '09:30'), 1, null)).toHaveLength(30)
  })

  it('keeps signals alone when there are no mirror events', () => {
    expect(pageMirrorSlice([], signalPair('11:30', '09:30'), 1, null)).toEqual([])
  })
})

const LINK_ID = '31ca68fd-0000-4000-8000-000000000000'

const openEvent = {
  id: 'e1',
  link_id: LINK_ID,
  mapping_id: 'm1',
  source_ticket: '3400415901',
  action: 'open',
  status: 'succeeded',
  request_payload: { symbol: 'XAUUSDm', volume: 0.01 },
  error_detail: null,
  created_at: '2026-10-24T00:02:21Z',
}

const mapping = {
  id: 'm1',
  source_symbol: 'XAUUSDm',
  destination_symbol: 'XAUUSDm',
  source_side: 'sell',
  source_volume: 0.01,
  destination_volume: 0.01,
  destination_ticket: '3389489202',
}

const links = [
  { id: LINK_ID, source_broker_account_id: 'src-1', destination_broker_account_id: 'dst-1' },
]
const brokers = [
  { id: 'src-1', label: 'MT5 • 476205231', account_login: '476205231' },
  { id: 'dst-1', label: 'MT5 • 477608729', account_login: '477608729' },
]

describe('normalizeMirrorCopyLogs', () => {
  it('turns a successful open event into an executed buy/sell row with master label', () => {
    expect(normalizeMirrorCopyLogs([openEvent], [mapping], links, brokers)).toEqual([
      {
        id: 'e1',
        createdAt: '2026-10-24T00:02:21Z',
        status: 'executed',
        action: 'open',
        side: 'sell',
        symbol: 'XAUUSDm',
        sourceTicket: '3400415901',
        lot: 0.01,
        channelName: 'MT5 • 476205231',
        destinationAccount: 'MT5 • 477608729',
        destinationTicket: '3389489202',
        reason: null,
      },
    ])
  })

  it('leaves the slave fields empty when the mapping ticket or slave label is missing', () => {
    const rows = normalizeMirrorCopyLogs(
      [{ ...openEvent, id: 'e9' }],
      [{ ...mapping, destination_ticket: null }],
      links,
      [{ id: 'src-1', label: 'MT5 • 476205231', account_login: '476205231' }],
    )
    expect(rows[0]).toMatchObject({ destinationTicket: null, destinationAccount: null })
  })

  it('keeps an uncertain close visible as pending rather than hiding it', () => {
    const rows = normalizeMirrorCopyLogs(
      [{ ...openEvent, id: 'e2', action: 'close', status: 'uncertain', error_detail: 'Market is closed' }],
      [mapping],
      links,
      brokers,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.side).toBeNull()
    expect(rows[0]!.reason).toBe('Market is closed')
  })

  it('renders events with no mapping (unsupported order types) without crashing', () => {
    const rows = normalizeMirrorCopyLogs(
      [{ ...openEvent, id: 'e3', mapping_id: null, action: 'unsupported', status: 'skipped' }],
      [],
      links,
      brokers,
    )
    expect(rows[0]).toMatchObject({
      status: 'skipped',
      action: 'unsupported',
      side: null,
      symbol: 'XAUUSDm',
      lot: 0.01,
      channelName: 'MT5 • 476205231',
    })
  })

  it('prefers the destination symbol and falls back to the account label when absent', () => {
    const rows = normalizeMirrorCopyLogs(
      [openEvent],
      [{ ...mapping, destination_symbol: 'GOLD', source_symbol: 'XAUUSDm' }],
      links,
      [{ id: 'src-1', label: null, account_login: '476205231' }],
    )
    expect(rows[0]!.symbol).toBe('GOLD')
    expect(rows[0]!.channelName).toBe('476205231')
  })

  it('returns newest first', () => {
    const rows = normalizeMirrorCopyLogs(
      [
        { ...openEvent, id: 'old', created_at: '2026-10-23T10:00:00Z' },
        { ...openEvent, id: 'new', created_at: '2026-10-24T09:00:00Z' },
      ],
      [mapping],
      links,
      brokers,
    )
    expect(rows.map(row => row.id)).toEqual(['new', 'old'])
  })
})

function chain(result: { data: unknown; error: unknown }) {
  const api: Record<string, unknown> = {}
  for (const method of ['select', 'in', 'order', 'limit', 'eq']) api[method] = () => api
  api.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return api
}

function fakeSupabase(tables: Record<string, { data: unknown; error: unknown }>): SupabaseClient {
  return {
    from(table: string) {
      return { select: () => chain(tables[table] ?? { data: [], error: null }) }
    },
  } as unknown as SupabaseClient
}

describe('fetchMirrorCopyLogs', () => {
  it('returns [] when the user has no copy links', async () => {
    const client = fakeSupabase({ broker_copy_links: { data: [], error: null } })
    expect(await fetchMirrorCopyLogs(client, 'user-1')).toEqual([])
  })

  it('normalises events, mappings, links and labels into log rows', async () => {
    const client = fakeSupabase({
      broker_copy_links: { data: links, error: null },
      mirror_copy_execution_events: { data: [openEvent], error: null },
      mirror_copy_trade_mappings: { data: [mapping], error: null },
      broker_accounts: { data: brokers, error: null },
    })
    const rows = await fetchMirrorCopyLogs(client, 'user-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'executed', side: 'sell', channelName: 'MT5 • 476205231' })
  })

  it('fails soft when the events table cannot be read (policy not applied yet)', async () => {
    const client = fakeSupabase({
      broker_copy_links: { data: links, error: null },
      mirror_copy_execution_events: { data: null, error: { message: 'permission denied' } },
    })
    expect(await fetchMirrorCopyLogs(client, 'user-1')).toEqual([])
  })

  it('returns [] without a user id', async () => {
    expect(await fetchMirrorCopyLogs(fakeSupabase({}), '')).toEqual([])
  })
})
