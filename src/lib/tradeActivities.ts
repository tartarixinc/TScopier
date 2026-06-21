import type { ManagementTranslations } from '../i18n/locales/types'
import {
  channelWorkerLogMessage,
  filterChannelWorkerDisplayLogs,
  resolveChannelNameFromLog,
  resolveInstrumentSymbol,
  type ChannelWorkerLogRow,
} from './channelWorkerLogMessage'
import type { ChannelWorkerTranslations } from '../i18n/channelWorker/types'

export type TradeActivityLogRow = ChannelWorkerLogRow & {
  id: string
  created_at: string
  signal_id?: string | null
  broker_account_id?: string | null
  signals?: {
    channel_id?: string | null
    parsed_data?: Record<string, unknown> | null
    raw_message?: string | null
    status?: string | null
    skip_reason?: string | null
  } | null
}

export type TradeActivityFilter = 'all' | 'successful' | 'skipped' | 'failed'

export type NormalizedActivityStatus = 'successful' | 'skipped' | 'failed'

type ChannelNameRow = { id: string; display_name: string; channel_username?: string | null }

const RETRY_ELIGIBLE_ACTIONS = new Set([
  'mgmt_breakeven',
  'mgmt_close',
  'mgmt_close_worse_entries',
  'mgmt_modify',
  'mgmt_partial_breakeven',
  'mgmt_partial_profit',
  'merge_modify_summary',
  'merge_routed_modify_only',
  'cwe_close',
  'auto_be',
  'trailing_stop',
  'order_send',
  'virtual_pending_fired',
  'virtual_pending_inserted',
  'signal_entry_pending_filled',
  'signal_range_entry_waiting',
  'signal_range_entry_no_price',
  'signal_range_entry_fired',
  'signal_range_entry_expired',
  'signal_range_entry_tp_before_entry',
  'signal_range_entry_sl_before_entry',
  'signal_range_entry_updated',
  'signal_range_entry_cancelled',
  'signal_range_entry_wake_retry',
  'opposite_signal_close',
  'partial_tp_fired',
  'basket_leg_modify',
])

const PIPELINE_ACTIONS = new Set([
  'pipeline_parse_dispatch',
  'pipeline_parse',
  'dispatch_received',
  'dispatch_skipped',
  'keyword_parse',
])

export function buildChannelDisplayNames(channels: ChannelNameRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of channels) {
    const name = c.display_name?.trim()
    const username = c.channel_username?.trim().replace(/^@/, '')
    out[c.id] = name || (username ? `@${username}` : 'Unnamed channel')
  }
  return out
}

export function dedupePipelineParseAttempts(logs: TradeActivityLogRow[]): TradeActivityLogRow[] {
  const terminalSignalIds = new Set(
    logs
      .filter(
        r =>
          r.action === 'pipeline_parse_dispatch'
          && (r.status === 'success' || r.status === 'failed')
          && r.signal_id,
      )
      .map(r => String(r.signal_id)),
  )
  return logs.filter(r => {
    if (
      r.action === 'pipeline_parse_dispatch'
      && r.status === 'attempt'
      && r.signal_id
      && terminalSignalIds.has(String(r.signal_id))
    ) {
      return false
    }
    return true
  })
}

export function normalizeActivityStatus(status: string): NormalizedActivityStatus | null {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'success') return 'successful'
  if (normalized === 'skipped') return 'skipped'
  if (normalized === 'failed') return 'failed'
  return null
}

function signalActionFromRow(row: TradeActivityLogRow): string {
  const parsed = row.signals?.parsed_data as Record<string, unknown> | null | undefined
  const fromParsed = String(parsed?.action ?? '').toLowerCase()
  if (fromParsed) return fromParsed
  const logAction = row.action.toLowerCase()
  if (logAction.startsWith('mgmt_')) return logAction.slice(5)
  return logAction
}

export function resolveTradeActivityKind(
  row: TradeActivityLogRow,
  mgmt: Pick<
    ManagementTranslations,
    | 'kindBreakeven'
    | 'kindClose'
    | 'kindCloseWorseEntries'
    | 'kindModify'
    | 'kindOrder'
    | 'kindLayering'
    | 'kindPipeline'
    | 'kindOther'
  >,
): string {
  const logAction = row.action.toLowerCase()
  const signalAction = signalActionFromRow(row)

  if (
    logAction === 'mgmt_breakeven'
    || signalAction === 'breakeven'
    || logAction === 'auto_be'
  ) {
    return mgmt.kindBreakeven
  }
  if (
    logAction === 'mgmt_close_worse_entries'
    || signalAction === 'close_worse_entries'
    || logAction === 'cwe_close'
  ) {
    return mgmt.kindCloseWorseEntries
  }
  if (logAction === 'mgmt_close' || signalAction === 'close') {
    return mgmt.kindClose
  }
  if (
    logAction === 'mgmt_modify'
    || logAction === 'merge_modify_summary'
    || logAction === 'merge_routed_modify_only'
    || logAction === 'trailing_stop'
    || signalAction === 'modify'
  ) {
    return mgmt.kindModify
  }
  if (
    logAction === 'order_send'
    || logAction === 'signal_entry_pending_filled'
    || signalAction === 'buy'
    || signalAction === 'sell'
  ) {
    return mgmt.kindOrder
  }
  if (
    logAction.startsWith('virtual_pending')
    || logAction === 'basket_leg_modify'
  ) {
    return mgmt.kindLayering
  }
  if (PIPELINE_ACTIONS.has(logAction)) {
    return mgmt.kindPipeline
  }
  return mgmt.kindOther
}

export function isRetryEligibleActivity(row: TradeActivityLogRow): boolean {
  if (row.status.trim().toLowerCase() !== 'failed') return false
  return RETRY_ELIGIBLE_ACTIONS.has(row.action.toLowerCase())
}

export interface DisplayableTradeActivity {
  row: TradeActivityLogRow
  message: string
  status: NormalizedActivityStatus
  kind: string
  symbol: string | null
  channelName: string | null
  retryEligible: boolean
}

export function buildDisplayableTradeActivities(
  rows: TradeActivityLogRow[],
  cw: ChannelWorkerTranslations,
  mgmt: ManagementTranslations,
  channelDisplayNames: Record<string, string>,
): DisplayableTradeActivity[] {
  const deduped = dedupePipelineParseAttempts(rows)
  const filtered = filterChannelWorkerDisplayLogs(deduped)

  const out: DisplayableTradeActivity[] = []
  for (const row of filtered) {
    const message = channelWorkerLogMessage(row, cw, channelDisplayNames)
    if (!message) continue
    const status = normalizeActivityStatus(row.status)
    if (!status) continue
    out.push({
      row,
      message,
      status,
      kind: resolveTradeActivityKind(row, mgmt),
      symbol: resolveInstrumentSymbol(row),
      channelName: resolveChannelNameFromLog(row, channelDisplayNames),
      retryEligible: isRetryEligibleActivity(row),
    })
  }
  return out
}

export function filterTradeActivitiesByTab(
  activities: DisplayableTradeActivity[],
  filter: TradeActivityFilter,
): DisplayableTradeActivity[] {
  if (filter === 'all') return activities
  return activities.filter(a => a.status === filter)
}

export const TRADE_ACTIVITY_FETCH_LIMIT = 500

export const TRADE_EXECUTION_LOG_SELECT = `
  id,
  created_at,
  action,
  status,
  request_payload,
  response_payload,
  error_message,
  signal_id,
  broker_account_id,
  signals ( channel_id, raw_message, parsed_data, status, skip_reason )
`
