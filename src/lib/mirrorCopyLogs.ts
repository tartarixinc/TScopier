import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mirror-copy activity for the /copier-logs page.
 *
 * The copier logs page lists `signals` rows (channel messages the copier parsed
 * and executed). Mirror trading has no signal at all — it copies the master
 * account's live positions — so its activity lives in
 * `mirror_copy_execution_events`, which nothing in the app could read until the
 * `20261024090000_mirror_copy_logs_read` policy. This module reads those events
 * and normalises them into the same status vocabulary the page filters on.
 *
 * Reads are bounded to the newest 200 events per user, so a very heavy mirror
 * account shows recent activity only. Raise the limit (or paginate the ledger)
 * once mirror volume makes that visible.
 */

/** Statuses the copier-logs filters understand. */
export type MirrorCopyLogStatus = 'executed' | 'skipped' | 'failed' | 'pending'

export type MirrorCopyLogRow = {
  id: string
  createdAt: string
  status: MirrorCopyLogStatus
  /**
   * Engine action. The DB CHECK on `mirror_copy_execution_events.action` allows
   * only `open`, `modify`, `close`, `unsupported`, `reconcile`.
   */
  action: string | null
  /** Side for an open copy; null for close/modify and when unknown. */
  side: 'buy' | 'sell' | null
  symbol: string
  sourceTicket: string | null
  lot: number | null
  /** Master account label, e.g. `MT5 • 476205231`. */
  channelName: string
  /** Slave account the copy sits on, e.g. `MT4 • 71901962`. */
  destinationAccount: string | null
  /** Broker ticket of the copy itself, once it reached the slave. */
  destinationTicket: string | null
  reason: string | null
}

type EventRow = {
  id: string
  link_id: string
  mapping_id: string | null
  source_ticket: string
  action: string
  status: string
  request_payload: Record<string, unknown> | null
  error_detail: string | null
  created_at: string
}

type MappingRow = {
  id: string
  source_symbol: string | null
  destination_symbol: string | null
  source_side: string | null
  source_volume: number | null
  destination_volume: number | null
  destination_ticket: string | null
}

type LinkRow = {
  id: string
  source_broker_account_id: string
  destination_broker_account_id: string
}

type BrokerRow = { id: string; label: string | null; account_login: string | null }

/**
 * Map a mirror event status onto the page's filter vocabulary. `uncertain` and
 * `claimed` are work in progress, so they read as pending rather than hiding.
 */
export const MIRROR_EVENT_STATUS_TO_FILTER: Record<string, MirrorCopyLogStatus> = {
  succeeded: 'executed',
  skipped: 'skipped',
  failed: 'failed',
  uncertain: 'pending',
  claimed: 'pending',
}

function normalizeSide(value: unknown): 'buy' | 'sell' | null {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'buy') return 'buy'
  if (text === 'sell') return 'sell'
  return null
}

function numberOrNull(value: unknown): number | null {
  // Number(null) is 0, which would report a missing lot as a real 0.01-lot row.
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function textOrNull(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text ? text : null
}

function brokerLabel(row: BrokerRow | undefined): string {
  if (!row) return '—'
  const label = String(row.label ?? '').trim()
  if (label) return label
  const login = String(row.account_login ?? '').trim()
  return login || '—'
}

/** Where one merged page (mirror rows first, then signals) begins and ends. */
export type MergedLogPagePlan = {
  /** Index into the mirror rows where this page starts. */
  mirrorStart: number
  /** How many mirror rows belong on this page. */
  mirrorCount: number
  /** Inclusive signal range, or null when this page holds mirror rows only. */
  signalFrom: number | null
  signalTo: number | null
}

/**
 * Split a merged log page between its two sources.
 *
 * Mirror rows take the front of the list, so they are sliced directly from
 * their own array; the signal window starts as many rows in. Two mistakes this
 * guards against: emitting every mirror row on every page (duplicates), and
 * clamping the offset before branching — which turns a page of pure mirror rows
 * into `range(0, 0)` and fetches one signal the page must not show.
 */
export function planMergedLogPage(
  page: number,
  pageSize: number,
  mirrorTotal: number,
): MergedLogPagePlan {
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  const rawSignalFrom = from - mirrorTotal
  const rawSignalTo = to - mirrorTotal
  return {
    mirrorStart: from,
    mirrorCount: Math.max(0, Math.min(pageSize, mirrorTotal - from)),
    signalFrom: rawSignalTo >= 0 ? Math.max(0, rawSignalFrom) : null,
    signalTo: rawSignalTo >= 0 ? rawSignalTo : null,
  }
}

/** Pure: turn the raw mirror tables into copier-log rows, newest first. */
export function normalizeMirrorCopyLogs(
  events: EventRow[],
  mappings: MappingRow[],
  links: LinkRow[],
  brokers: BrokerRow[],
): MirrorCopyLogRow[] {
  const mappingById = new Map(mappings.map(row => [row.id, row]))
  const labelByAccount = new Map(brokers.map(row => [row.id, brokerLabel(row)]))
  const linkById = new Map(links.map(row => [row.id, row]))

  return events
    .map((event): MirrorCopyLogRow => {
      const mapping = event.mapping_id ? mappingById.get(event.mapping_id) : undefined
      const request = event.request_payload ?? {}
      const link = linkById.get(event.link_id)
      const side = normalizeSide(mapping?.source_side)
      const action = String(event.action ?? '').trim() || null

      return {
        id: event.id,
        createdAt: event.created_at,
        status: MIRROR_EVENT_STATUS_TO_FILTER[String(event.status ?? '')] ?? 'pending',
        action,
        side: action === 'open' ? side : null,
        symbol: String(mapping?.destination_symbol ?? mapping?.source_symbol ?? request.symbol ?? '').trim() || '—',
        sourceTicket: textOrNull(event.source_ticket),
        lot: numberOrNull(mapping?.destination_volume ?? mapping?.source_volume ?? request.volume),
        channelName: (link && labelByAccount.get(link.source_broker_account_id)) || '—',
        destinationAccount: (link && labelByAccount.get(link.destination_broker_account_id)) || null,
        destinationTicket: textOrNull(mapping?.destination_ticket),
        reason: textOrNull(event.error_detail),
      }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/**
 * Read the user's mirror-copy events, newest first. Fail-soft by design: the
 * copier-logs page must keep working if the policy has not been applied yet or
 * any of the reads fail, so every error becomes an empty list.
 */
export async function fetchMirrorCopyLogs(
  supabase: SupabaseClient,
  userId: string,
  limit = 200,
): Promise<MirrorCopyLogRow[]> {
  if (!userId) return []

  const { data: links, error: linkError } = await supabase
    .from('broker_copy_links')
    .select('id,source_broker_account_id,destination_broker_account_id')
    .eq('user_id', userId)
  if (linkError || !links?.length) return []

  const linkRows = links as LinkRow[]
  const linkIds = linkRows.map(row => row.id)

  const { data: eventRows, error: eventsError } = await supabase
    .from('mirror_copy_execution_events')
    .select('id,link_id,mapping_id,source_ticket,action,status,request_payload,error_detail,created_at')
    .in('link_id', linkIds)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (eventsError || !eventRows?.length) return []
  const events = eventRows as unknown as EventRow[]

  // Only the mappings these events actually reference are needed, so a long-lived
  // mirror user does not pull every mapping they ever had.
  const mappingIds = [...new Set(events.map(row => row.mapping_id).filter((id): id is string => Boolean(id)))]
  // Both ends: the modal names the master and the slave the copy sits on.
  const accountIds = [...new Set(linkRows.flatMap(row => [row.source_broker_account_id, row.destination_broker_account_id]))]
  const [mappingsRes, brokersRes] = await Promise.all([
    supabase
      .from('mirror_copy_trade_mappings')
      .select('id,source_symbol,destination_symbol,source_side,source_volume,destination_volume,destination_ticket')
      .in('id', mappingIds),
    supabase
      .from('broker_accounts')
      .select('id,label,account_login')
      .in('id', accountIds),
  ])

  return normalizeMirrorCopyLogs(
    events,
    (mappingsRes.data ?? []) as unknown as MappingRow[],
    linkRows,
    (brokersRes.data ?? []) as BrokerRow[],
  )
}
