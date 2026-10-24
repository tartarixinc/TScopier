import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchMirrorCopyLogs, normalizeMirrorCopyLogs, planMergedLogPage } from './mirrorCopyLogs'

describe('planMergedLogPage', () => {
  it('puts mirror rows first and offsets the signal window by their count', () => {
    // 3 mirror rows, page size 25: page 1 shows the 3 + signals 0..21.
    expect(planMergedLogPage(1, 25, 3)).toEqual({
      mirrorStart: 0,
      mirrorCount: 3,
      signalFrom: 0,
      signalTo: 21,
    })
    expect(planMergedLogPage(1, 25, 3).mirrorCount + (21 - 0 + 1)).toBe(25)
  })

  it('emits no mirror rows past their range, so page 2 does not repeat them', () => {
    const page2 = planMergedLogPage(2, 25, 3)
    expect(page2.mirrorCount).toBe(0)
    expect(page2.signalFrom).toBe(22)
    expect(page2.signalTo).toBe(46)
    expect(page2.signalTo! - page2.signalFrom! + 1).toBe(25)
  })

  it('fetches no signals for a page made of mirror rows alone', () => {
    // The pre-fix clamp turned this into range(0, 0), i.e. one extra signal.
    const plan = planMergedLogPage(1, 10, 10)
    expect(plan).toEqual({ mirrorStart: 0, mirrorCount: 10, signalFrom: null, signalTo: null })
  })

  it('slices a mirror list longer than one page across pages', () => {
    const page1 = planMergedLogPage(1, 25, 30)
    expect(page1.mirrorCount).toBe(25)
    expect(page1.signalFrom).toBeNull()

    const page2 = planMergedLogPage(2, 25, 30)
    expect(page2.mirrorStart).toBe(25)
    expect(page2.mirrorCount).toBe(5)
    expect(page2.signalFrom).toBe(0)
    expect(page2.signalTo).toBe(19)
    expect(page2.mirrorCount + (20 - 0)).toBe(25)
  })

  it('behaves like plain signal pagination when there are no mirror rows', () => {
    expect(planMergedLogPage(1, 25, 0)).toEqual({
      mirrorStart: 0,
      mirrorCount: 0,
      signalFrom: 0,
      signalTo: 24,
    })
    expect(planMergedLogPage(3, 10, 0)).toMatchObject({ mirrorCount: 0, signalFrom: 20, signalTo: 29 })
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
}

const links = [{ id: LINK_ID, source_broker_account_id: 'src-1' }]
const brokers = [{ id: 'src-1', label: 'MT5 • 476205231', account_login: '476205231' }]

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
        reason: null,
      },
    ])
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
