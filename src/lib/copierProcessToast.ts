import type { ManagementTranslations } from '../i18n/locales/types'
import type { ChannelWorkerTranslations } from '../i18n/channelWorker/types'
import type { SignalSourceKind } from './signalSourceMark'
import {
  buildDisplayableTradeActivities,
  shouldRefreshActivitiesOnRealtimePayload,
  type TradeActivityLogRow,
} from './tradeActivities'

export type CopierProcessToast = {
  logId: string
  status: 'successful' | 'skipped' | 'failed'
  title: string
  detail: string
  channelName: string | null
  symbol: string | null
}

const SEEN_STORAGE_PREFIX = 'tsc_copier_process_toasts_seen:'
const SEEN_STORAGE_MAX = 200

export function copierProcessToastFingerprint(
  row: Pick<TradeActivityLogRow, 'id' | 'status' | 'action'>,
): string {
  return `${row.id}|${row.status}|${row.action}`
}

export function mergeCopierProcessToastSeen(
  seen: Map<string, string>,
  rows: Array<Pick<TradeActivityLogRow, 'id' | 'status' | 'action'>>,
): void {
  for (const row of rows) {
    seen.set(row.id, copierProcessToastFingerprint(row))
  }
}

export function shouldAnnounceCopierProcessToast(
  seen: Map<string, string>,
  row: Pick<TradeActivityLogRow, 'id' | 'status' | 'action'>,
): 'show' | 'skip' {
  if (!shouldRefreshActivitiesOnRealtimePayload(row)) return 'skip'
  const fingerprint = copierProcessToastFingerprint(row)
  if (seen.get(row.id) === fingerprint) return 'skip'
  seen.set(row.id, fingerprint)
  return 'show'
}

export function readCopierProcessToastSeen(userId: string): Map<string, string> {
  if (typeof sessionStorage === 'undefined') return new Map()
  try {
    const raw = sessionStorage.getItem(`${SEEN_STORAGE_PREFIX}${userId}`)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Map()
    const out = new Map<string, string>()
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const id = entry[0]
      const fingerprint = entry[1]
      if (typeof id === 'string' && typeof fingerprint === 'string') out.set(id, fingerprint)
    }
    return out
  } catch {
    return new Map()
  }
}

export function writeCopierProcessToastSeen(userId: string, seen: Map<string, string>): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    const entries = [...seen.entries()].slice(-SEEN_STORAGE_MAX)
    sessionStorage.setItem(`${SEEN_STORAGE_PREFIX}${userId}`, JSON.stringify(entries))
  } catch {
    // Quota / private mode — in-memory seen still works for this page life.
  }
}

export function copierProcessToastFromLog(
  row: TradeActivityLogRow,
  cw: ChannelWorkerTranslations,
  mgmt: ManagementTranslations,
  channelDisplayNames: Record<string, string>,
  channelSourceKinds: Record<string, SignalSourceKind> = {},
): CopierProcessToast | null {
  const [activity] = buildDisplayableTradeActivities(
    [row],
    cw,
    mgmt,
    channelDisplayNames,
    channelSourceKinds,
  )
  if (!activity) return null
  return {
    logId: row.id,
    status: activity.status,
    title: activity.kind,
    detail: activity.message,
    channelName: activity.channelName,
    symbol: activity.symbol,
  }
}
