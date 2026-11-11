import type { SupabaseClient } from '@supabase/supabase-js'
import type { DisplayableTradeActivity, NormalizedActivityStatus } from './tradeActivities'
import type { ManagementTranslations } from '../i18n/locales/types'

/**
 * Social-copy activity for /copier-logs and /activities.
 *
 * Like mirror copy, social trading has no Telegram `signals` row — the provider's
 * live positions are mirrored onto the subscriber's broker. Activity lives in
 * `social_copy_execution_events` (and, when the edge reconciler has not written
 * events yet, in `social_copy_trade_mappings`).
 */

export type SocialCopyLogStatus = 'executed' | 'skipped' | 'failed' | 'pending'

export type SocialCopyLogRow = {
  id: string
  createdAt: string
  status: SocialCopyLogStatus
  action: string | null
  side: 'buy' | 'sell' | null
  symbol: string
  sourceTicket: string | null
  lot: number | null
  /** Provider display name (or fallback). */
  channelName: string
  destinationAccount: string | null
  destinationTicket: string | null
  destinationBrokerAccountId: string | null
  reason: string | null
}

type EventRow = {
  id: string
  subscription_id: string
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
  subscription_id: string
  source_ticket: string
  source_symbol: string | null
  destination_symbol: string | null
  source_side: string | null
  source_volume: number | null
  destination_volume: number | null
  destination_ticket: string | null
  state: string
  opened_at: string | null
  closed_at: string | null
  created_at: string
  last_error_detail: string | null
}

type SubscriptionRow = {
  id: string
  source_trader_user_id: string
  destination_broker_account_id: string
}

type BrokerRow = { id: string; label: string | null; account_login: string | null }

export const SOCIAL_EVENT_STATUS_TO_FILTER: Record<string, SocialCopyLogStatus> = {
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

/** Pure: turn social execution events into copier-log rows, newest first. */
export function normalizeSocialCopyLogs(
  events: EventRow[],
  mappings: MappingRow[],
  subscriptions: SubscriptionRow[],
  brokers: BrokerRow[],
  providerNames: Record<string, string>,
): SocialCopyLogRow[] {
  const mappingById = new Map(mappings.map(row => [row.id, row]))
  const labelByAccount = new Map(brokers.map(row => [row.id, brokerLabel(row)]))
  const subById = new Map(subscriptions.map(row => [row.id, row]))

  return events
    .map((event): SocialCopyLogRow => {
      const mapping = event.mapping_id ? mappingById.get(event.mapping_id) : undefined
      const request = event.request_payload ?? {}
      const sub = subById.get(event.subscription_id)
      const side = normalizeSide(mapping?.source_side ?? request.side)
      const action = String(event.action ?? '').trim() || null
      const providerName = (sub && providerNames[sub.source_trader_user_id]) || 'Provider'

      return {
        id: event.id,
        createdAt: event.created_at,
        status: SOCIAL_EVENT_STATUS_TO_FILTER[String(event.status ?? '')] ?? 'pending',
        action,
        side: action === 'open' ? side : null,
        symbol: String(mapping?.destination_symbol ?? mapping?.source_symbol ?? request.symbol ?? '').trim() || '—',
        sourceTicket: textOrNull(event.source_ticket),
        lot: numberOrNull(mapping?.destination_volume ?? mapping?.source_volume ?? request.volume),
        channelName: providerName,
        destinationAccount: (sub && labelByAccount.get(sub.destination_broker_account_id)) || null,
        destinationTicket: textOrNull(mapping?.destination_ticket),
        destinationBrokerAccountId: sub?.destination_broker_account_id ?? null,
        reason: textOrNull(event.error_detail),
      }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/**
 * When the edge reconciler opened copies before it started writing events,
 * synthesise log rows from trade mappings so the UI is not empty.
 */
export function synthesizeSocialCopyLogsFromMappings(
  mappings: MappingRow[],
  subscriptions: SubscriptionRow[],
  brokers: BrokerRow[],
  providerNames: Record<string, string>,
): SocialCopyLogRow[] {
  const labelByAccount = new Map(brokers.map(row => [row.id, brokerLabel(row)]))
  const subById = new Map(subscriptions.map(row => [row.id, row]))
  const rows: SocialCopyLogRow[] = []

  for (const mapping of mappings) {
    const sub = subById.get(mapping.subscription_id)
    const providerName = (sub && providerNames[sub.source_trader_user_id]) || 'Provider'
    const destinationAccount = (sub && labelByAccount.get(sub.destination_broker_account_id)) || null
    const destinationBrokerAccountId = sub?.destination_broker_account_id ?? null
    const side = normalizeSide(mapping.source_side)
    const symbol = String(mapping.destination_symbol ?? mapping.source_symbol ?? '').trim() || '—'
    const lot = numberOrNull(mapping.destination_volume ?? mapping.source_volume)

    if (mapping.state === 'opening') {
      rows.push({
        id: `mapping:${mapping.id}:opening`,
        createdAt: mapping.created_at,
        status: 'pending',
        action: 'open',
        side,
        symbol,
        sourceTicket: textOrNull(mapping.source_ticket),
        lot,
        channelName: providerName,
        destinationAccount,
        destinationTicket: null,
        destinationBrokerAccountId,
        reason: textOrNull(mapping.last_error_detail),
      })
      continue
    }

    if (mapping.opened_at || mapping.state === 'open' || mapping.state === 'closed' || mapping.state === 'closing') {
      rows.push({
        id: `mapping:${mapping.id}:open`,
        createdAt: mapping.opened_at ?? mapping.created_at,
        status: mapping.state === 'error' ? 'failed' : mapping.state === 'uncertain' ? 'pending' : 'executed',
        action: 'open',
        side,
        symbol,
        sourceTicket: textOrNull(mapping.source_ticket),
        lot,
        channelName: providerName,
        destinationAccount,
        destinationTicket: textOrNull(mapping.destination_ticket),
        destinationBrokerAccountId,
        reason: textOrNull(mapping.last_error_detail),
      })
    }

    if (mapping.state === 'closed' && mapping.closed_at) {
      rows.push({
        id: `mapping:${mapping.id}:close`,
        createdAt: mapping.closed_at,
        status: 'executed',
        action: 'close',
        side: null,
        symbol,
        sourceTicket: textOrNull(mapping.source_ticket),
        lot,
        channelName: providerName,
        destinationAccount,
        destinationTicket: textOrNull(mapping.destination_ticket),
        destinationBrokerAccountId,
        reason: null,
      })
    }

    if (mapping.state === 'error') {
      rows.push({
        id: `mapping:${mapping.id}:error`,
        createdAt: mapping.created_at,
        status: 'failed',
        action: 'open',
        side,
        symbol,
        sourceTicket: textOrNull(mapping.source_ticket),
        lot,
        channelName: providerName,
        destinationAccount,
        destinationTicket: textOrNull(mapping.destination_ticket),
        destinationBrokerAccountId,
        reason: textOrNull(mapping.last_error_detail),
      })
    }
  }

  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

async function loadProviderNames(
  supabase: SupabaseClient,
  traderIds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (traderIds.length === 0) return out
  try {
    const { data, error } = await supabase.rpc('get_social_directory')
    if (error || !Array.isArray(data)) return out
    const wanted = new Set(traderIds)
    for (const row of data as Array<{ profile_user_id?: string; display_name?: string; username?: string }>) {
      const id = String(row.profile_user_id ?? '')
      if (!wanted.has(id)) continue
      const name = String(row.display_name ?? '').trim() || String(row.username ?? '').trim()
      if (name) out[id] = name
    }
  } catch {
    // Directory is best-effort; logs still render with "Provider".
  }
  return out
}

type ProviderTradeRow = {
  id: string
  broker_account_id: string | null
  symbol: string
  direction: string
  lot_size: number | null
  status: string
  opened_at: string
  closed_at: string | null
  metaapi_order_id: string | null
  broker_position_ticket: string | null
  /** Set when the fill came from a channel signal (Telegram/TV/Discord/WhatsApp). */
  signal_id?: string | null
}

/**
 * Trades on the user's published social source MT accounts (manual broker opens).
 * Shown as Manual Execution — never as Social trading (that label is follower-only).
 * Signal-linked fills (TradingView, Telegram, etc.) are excluded — those stay
 * under their channel source in Copier Logs.
 */
export function normalizeSocialProviderSourceTrades(
  trades: ProviderTradeRow[],
  accountLabels: Record<string, string>,
): SocialCopyLogRow[] {
  const rows: SocialCopyLogRow[] = []
  for (const trade of trades) {
    if (trade.signal_id) continue
    const side = normalizeSide(trade.direction)
    const ticket = textOrNull(trade.metaapi_order_id ?? trade.broker_position_ticket)
    const symbol = String(trade.symbol ?? '').trim() || '—'
    const lot = numberOrNull(trade.lot_size)
    const accountLabel = (trade.broker_account_id && accountLabels[trade.broker_account_id]) || 'Source account'
    const closed = Boolean(trade.closed_at) || String(trade.status).toLowerCase() === 'closed'

    rows.push({
      id: `provider-trade:${trade.id}:open`,
      createdAt: trade.opened_at,
      status: 'executed',
      action: 'open',
      side,
      symbol,
      sourceTicket: ticket,
      lot,
      channelName: accountLabel,
      destinationAccount: null,
      destinationTicket: null,
      destinationBrokerAccountId: trade.broker_account_id,
      reason: null,
    })
    if (closed && trade.closed_at) {
      rows.push({
        id: `provider-trade:${trade.id}:close`,
        createdAt: trade.closed_at,
        status: 'executed',
        action: 'close',
        side: null,
        symbol,
        sourceTicket: ticket,
        lot,
        channelName: accountLabel,
        destinationAccount: null,
        destinationTicket: null,
        destinationBrokerAccountId: trade.broker_account_id,
        reason: null,
      })
    }
  }
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/** Provider's published-source broker trades as Manual Execution log rows. */
export async function fetchSocialProviderSourceTradeLogs(
  supabase: SupabaseClient,
  userId: string,
  limit = 100,
): Promise<SocialCopyLogRow[]> {
  if (!userId) return []

  const { data: sources, error: sourceError } = await supabase
    .from('social_copy_sources')
    .select('id,broker_account_id,label')
    .eq('trader_user_id', userId)
    .in('status', ['published', 'paused'])
  if (sourceError || !sources?.length) return []

  const sourceRows = sources as Array<{ id: string; broker_account_id: string; label: string | null }>
  const accountIds = [...new Set(sourceRows.map(row => row.broker_account_id))]

  const [tradesRes, brokersRes] = await Promise.all([
    supabase
      .from('trades')
      .select('id,broker_account_id,symbol,direction,lot_size,status,opened_at,closed_at,metaapi_order_id,broker_position_ticket,signal_id')
      .eq('user_id', userId)
      .in('broker_account_id', accountIds)
      // Channel-copied fills (TV/Telegram/…) carry signal_id — not Manual Execution.
      .is('signal_id', null)
      .order('opened_at', { ascending: false })
      .limit(limit),
    supabase
      .from('broker_accounts')
      .select('id,label,account_login')
      .in('id', accountIds),
  ])
  if (tradesRes.error || !tradesRes.data?.length) return []

  const accountLabels: Record<string, string> = {}
  for (const source of sourceRows) {
    const label = String(source.label ?? '').trim()
    if (label) accountLabels[source.broker_account_id] = label
  }
  for (const broker of (brokersRes.data ?? []) as BrokerRow[]) {
    if (accountLabels[broker.id]) continue
    accountLabels[broker.id] = brokerLabel(broker)
  }

  return normalizeSocialProviderSourceTrades(
    tradesRes.data as unknown as ProviderTradeRow[],
    accountLabels,
  )
}

async function fetchSubscriberSocialCopyLogs(
  supabase: SupabaseClient,
  userId: string,
  limit: number,
): Promise<SocialCopyLogRow[]> {
  const { data: subs, error: subError } = await supabase
    .from('social_copy_subscriptions')
    .select('id,source_trader_user_id,destination_broker_account_id')
    .eq('subscriber_user_id', userId)
  if (subError || !subs?.length) return []

  const subscriptions = subs as SubscriptionRow[]
  const subscriptionIds = subscriptions.map(row => row.id)
  const accountIds = [...new Set(subscriptions.map(row => row.destination_broker_account_id))]
  const traderIds = [...new Set(subscriptions.map(row => row.source_trader_user_id))]

  const [eventsRes, mappingsRes, brokersRes, providerNames] = await Promise.all([
    supabase
      .from('social_copy_execution_events')
      .select('id,subscription_id,mapping_id,source_ticket,action,status,request_payload,error_detail,created_at')
      .in('subscription_id', subscriptionIds)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('social_copy_trade_mappings')
      .select('id,subscription_id,source_ticket,source_symbol,destination_symbol,source_side,source_volume,destination_volume,destination_ticket,state,opened_at,closed_at,created_at,last_error_detail')
      .in('subscription_id', subscriptionIds)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('broker_accounts')
      .select('id,label,account_login')
      .in('id', accountIds),
    loadProviderNames(supabase, traderIds),
  ])

  const brokers = (brokersRes.data ?? []) as BrokerRow[]
  const mappings = (mappingsRes.data ?? []) as unknown as MappingRow[]

  if (!eventsRes.error && eventsRes.data?.length) {
    const events = eventsRes.data as unknown as EventRow[]
    const mappingIds = [...new Set(events.map(row => row.mapping_id).filter((id): id is string => Boolean(id)))]
    const eventMappings = mappingIds.length
      ? mappings.filter(row => mappingIds.includes(row.id))
      : mappings
    return normalizeSocialCopyLogs(events, eventMappings, subscriptions, brokers, providerNames)
  }

  if (!mappingsRes.error && mappings.length) {
    return synthesizeSocialCopyLogsFromMappings(mappings, subscriptions, brokers, providerNames)
  }

  return []
}

/** True when the user has a published/paused Social Trading source account. */
export async function userIsPublishedSocialProvider(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  if (!userId) return false
  const { data, error } = await supabase
    .from('social_copy_sources')
    .select('id')
    .eq('trader_user_id', userId)
    .in('status', ['published', 'paused'])
    .limit(1)
  if (error) return false
  return (data?.length ?? 0) > 0
}

/**
 * Follower-only social trading activity for Copier Logs / Trade Activities.
 * Published providers never see Social trading rows here — their own broker
 * activity uses {@link fetchManualSourceTradeLogs} (Manual Execution).
 */
export async function fetchSocialCopyLogs(
  supabase: SupabaseClient,
  userId: string,
  limit = 200,
): Promise<SocialCopyLogRow[]> {
  if (!userId) return []
  try {
    if (await userIsPublishedSocialProvider(supabase, userId)) return []
    return await fetchSubscriberSocialCopyLogs(supabase, userId, limit)
  } catch {
    return []
  }
}

/**
 * Destination tickets filled by this user's social subscriptions.
 * Those positions are copy fills, not Manual Execution on a published source.
 */
async function loadSubscriberDestinationTickets(
  supabase: SupabaseClient,
  userId: string,
): Promise<Set<string>> {
  const out = new Set<string>()
  const { data: subs, error: subError } = await supabase
    .from('social_copy_subscriptions')
    .select('id')
    .eq('subscriber_user_id', userId)
  if (subError || !subs?.length) return out
  const subscriptionIds = (subs as Array<{ id: string }>).map(row => row.id)
  const { data: mappings } = await supabase
    .from('social_copy_trade_mappings')
    .select('destination_ticket')
    .in('subscription_id', subscriptionIds)
    .not('destination_ticket', 'is', null)
  for (const row of (mappings ?? []) as Array<{ destination_ticket: string | null }>) {
    const ticket = String(row.destination_ticket ?? '').trim()
    if (ticket) out.add(ticket)
  }
  return out
}

/** Alias: provider published-source MT trades labeled Manual Execution in the UI. */
export async function fetchManualSourceTradeLogs(
  supabase: SupabaseClient,
  userId: string,
  limit = 100,
): Promise<SocialCopyLogRow[]> {
  const [rows, socialDestTickets] = await Promise.all([
    fetchSocialProviderSourceTradeLogs(supabase, userId, limit),
    loadSubscriberDestinationTickets(supabase, userId).catch(() => new Set<string>()),
  ])
  if (socialDestTickets.size === 0) return rows
  // Drop copy-destination fills so they are not branded Manual Execution.
  return rows.filter(row => {
    const ticket = String(row.sourceTicket ?? '').trim()
    return !ticket || !socialDestTickets.has(ticket)
  })
}

function activityStatus(status: SocialCopyLogStatus): NormalizedActivityStatus | null {
  if (status === 'executed') return 'successful'
  if (status === 'skipped') return 'skipped'
  if (status === 'failed') return 'failed'
  return null
}

/**
 * How many social opens succeeded in `[rangeStartIso, rangeEndIso)`.
 * Used by the dashboard "Trades Copied Today" tile alongside channel signals.
 */
export async function countSocialCopyOpensInRange(
  supabase: SupabaseClient,
  userId: string,
  rangeStartIso: string,
  rangeEndIso: string,
): Promise<number> {
  if (!userId || !rangeStartIso || !rangeEndIso) return 0

  const { data: subs, error: subError } = await supabase
    .from('social_copy_subscriptions')
    .select('id')
    .eq('subscriber_user_id', userId)
  if (subError || !subs?.length) return 0
  const subscriptionIds = (subs as Array<{ id: string }>).map(row => row.id)

  const { count, error } = await supabase
    .from('social_copy_execution_events')
    .select('id', { count: 'exact', head: true })
    .in('subscription_id', subscriptionIds)
    .eq('action', 'open')
    .eq('status', 'succeeded')
    .gte('created_at', rangeStartIso)
    .lt('created_at', rangeEndIso)

  if (!error && typeof count === 'number') return count

  // Events may be empty before the reconciler wrote them — count mappings instead.
  const { count: mappingCount, error: mappingError } = await supabase
    .from('social_copy_trade_mappings')
    .select('id', { count: 'exact', head: true })
    .in('subscription_id', subscriptionIds)
    .not('opened_at', 'is', null)
    .gte('opened_at', rangeStartIso)
    .lt('opened_at', rangeEndIso)

  if (mappingError || mappingCount == null) return 0
  return mappingCount
}

type ActivityMessageLabels = {
  source: string
  openMessage: string
  closeMessage: string
  modifyMessage: string
  otherMessage: string
}

function buildCopyStyleTradeActivities(
  rows: SocialCopyLogRow[],
  mgmt: Pick<ManagementTranslations, 'kindOrder' | 'kindClose' | 'kindModify' | 'kindOther'>,
  labels: ActivityMessageLabels,
  options: { idPrefix: string; sourceKind: 'social' | 'manual' },
): DisplayableTradeActivity[] {
  const out: DisplayableTradeActivity[] = []
  for (const row of rows) {
    const status = activityStatus(row.status)
    if (!status) continue

    const detail = `${[row.side, row.symbol].filter(Boolean).join(' ')}${row.lot == null ? '' : ` (${row.lot} lot)`}`
      || row.action
      || ''
    const ticket = row.sourceTicket || '—'
    let message: string
    switch (row.action) {
      case 'open':
        message = labels.openMessage
          .replace('{detail}', detail)
          .replace('{ticket}', ticket)
        break
      case 'close':
        message = labels.closeMessage.replace('{ticket}', ticket)
        break
      case 'modify':
        message = labels.modifyMessage.replace('{ticket}', ticket)
        break
      default:
        message = labels.otherMessage
          .replace('{action}', row.action ?? '')
          .replace('{ticket}', ticket)
    }

    const kind = row.action === 'close'
      ? mgmt.kindClose
      : row.action === 'modify'
        ? mgmt.kindModify
        : row.action === 'open'
          ? mgmt.kindOrder
          : mgmt.kindOther

    const logStatus = status === 'successful' ? 'success' : status
    out.push({
      row: {
        id: `${options.idPrefix}:${row.id}`,
        created_at: row.createdAt,
        action: row.action === 'close' ? 'mgmt_close' : 'order_send',
        status: logStatus,
        request_payload: {
          symbol: row.symbol,
          source_kind: options.sourceKind,
          provider_name: row.channelName,
        },
        response_payload: null,
        error_message: row.reason,
        signal_id: null,
        broker_account_id: row.destinationBrokerAccountId,
        signals: null,
      },
      message,
      status,
      kind,
      symbol: row.symbol === '—' ? null : row.symbol,
      channelName: `${labels.source} · ${row.channelName}`,
      sourceKind: null,
      retryEligible: false,
    })
  }
  return out
}

/** Turn follower social-copy log rows into the same shape /activities already renders. */
export function buildSocialCopyTradeActivities(
  rows: SocialCopyLogRow[],
  mgmt: Pick<ManagementTranslations, 'kindOrder' | 'kindClose' | 'kindModify' | 'kindOther'>,
  labels: ActivityMessageLabels,
): DisplayableTradeActivity[] {
  return buildCopyStyleTradeActivities(rows, mgmt, labels, { idPrefix: 'social', sourceKind: 'social' })
}

/** Provider-owned published-source trades as Manual Execution activities. */
export function buildManualSourceTradeActivities(
  rows: SocialCopyLogRow[],
  mgmt: Pick<ManagementTranslations, 'kindOrder' | 'kindClose' | 'kindModify' | 'kindOther'>,
  labels: ActivityMessageLabels,
): DisplayableTradeActivity[] {
  return buildCopyStyleTradeActivities(rows, mgmt, labels, { idPrefix: 'manual', sourceKind: 'manual' })
}
