/** MT order field helpers (mirrors supabase/functions/_shared/mtTradeFields.ts). */

type RawMtOrder = Record<string, unknown>
export type MtHistoryProfile = 'dashboard' | 'trades'

const MT_DEAL_NESTED_OBJECTS = [
  'dealInternalOut',
  'DealInternalOut',
  'dealInternalIn',
  'DealInternalIn',
  'orderInternal',
  'OrderInternal',
  'ex',
  'Ex',
  'deal',
  'Deal',
  'position',
  'Position',
  'result',
  'Result',
] as const

function isPlainObject(v: unknown): v is RawMtOrder {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function scalarValue(v: unknown): boolean {
  return v !== null && v !== undefined && typeof v !== 'object'
}

function shallowUnwrapResult(row: RawMtOrder): RawMtOrder {
  const flat: RawMtOrder = { ...row }
  if (isPlainObject(flat.result)) {
    for (const [k, v] of Object.entries(flat.result as RawMtOrder)) {
      if (!scalarValue(v)) continue
      if (flat[k] === undefined || flat[k] === null) flat[k] = v
    }
  }
  return flat
}

function flattenMtOrder(row: unknown, profile: MtHistoryProfile = 'trades'): RawMtOrder {
  if (!isPlainObject(row)) return {}
  if (profile === 'dashboard') return shallowUnwrapResult(row)

  const flat: RawMtOrder = { ...row }
  const absorb = (src: RawMtOrder) => {
    for (const [k, v] of Object.entries(src)) {
      if (!scalarValue(v)) continue
      const cur = flat[k]
      if (cur === undefined || cur === null || cur === '') {
        flat[k] = v
        continue
      }
      if (typeof cur === 'number' && cur === 0 && typeof v === 'number' && v !== 0) {
        flat[k] = v
      }
    }
  }

  if (isPlainObject(flat.result)) absorb(flat.result as RawMtOrder)
  for (const key of MT_DEAL_NESTED_OBJECTS) {
    const nested = flat[key]
    if (isPlainObject(nested)) absorb(nested)
  }

  const ticket = Number(flat.ticket ?? flat.Ticket ?? 0)
  if (!(ticket > 0)) {
    const tn = Number(
      flat.ticketNumber ?? flat.TicketNumber ?? flat.dealTicket ?? flat.DealTicket ?? 0,
    )
    if (tn > 0) flat.ticket = tn
  }

  return flat
}

function pickMtField(order: RawMtOrder, profile: MtHistoryProfile, ...keys: string[]): unknown {
  if (profile === 'trades') {
    const flat = flattenMtOrder(order, 'trades')
    for (const k of keys) {
      if (flat[k] !== undefined && flat[k] !== null) return flat[k]
    }
    return undefined
  }

  for (const k of keys) {
    if (order[k] !== undefined && order[k] !== null) return order[k]
  }
  const ex = order.ex
  if (isPlainObject(ex)) {
    for (const k of keys) {
      if (ex[k] !== undefined && ex[k] !== null) return ex[k]
    }
  }
  return undefined
}

function numMtField(order: RawMtOrder, profile: MtHistoryProfile, ...keys: string[]): number | null {
  const v = pickMtField(order, profile, ...keys)
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** First key whose value parses to a finite number > 0 (skips present-but-zero keys). */
function firstPositiveNumMtField(order: RawMtOrder, profile: MtHistoryProfile, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = pickMtField(order, profile, k)
    if (v === null || v === undefined || v === '') continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

/** Resolve the trade size in standard lots. Scans keys first-positive so a
 * present-but-zero key (closeLots: 0) can never shadow a later positive one. */
export function resolveMtLots(order: RawMtOrder, profile: MtHistoryProfile): number {
  const keys =
    profile === 'trades'
      ? ['lots', 'Lots', 'lot', 'Lot', 'volumeLots', 'VolumeLots', 'closeLots', 'CloseLots', 'requestLots', 'RequestLots']
      : ['lots', 'Lots', 'lot', 'Lot', 'volumeLots', 'VolumeLots']

  // First PRESENT key is not enough: open orders echo closeLots/closeVolume: 0
  // and would shadow a later positive key — scan for the first value > 0
  // (matches the edge's zero-shadowing rule only; key order and the
  // volExt/flatten handling still differ from
  // supabase/functions/_shared/mtTradeFields.ts — see PROJECT_MEMORY).
  const direct = firstPositiveNumMtField(order, profile, ...keys)
  if (direct != null) return direct

  const volExt = firstPositiveNumMtField(order, profile, 'volumeExt', 'VolumeExt')
  if (volExt != null) {
    if (volExt >= 1_000_000) return volExt / 100_000_000
    if (volExt >= 10_000) return volExt / 10_000
  }

  const vol = firstPositiveNumMtField(
    order,
    profile,
    'volume',
    'Volume',
    'volumeClosed',
    'VolumeClosed',
    'closeVolume',
    'CloseVolume',
    'requestVolume',
    'RequestVolume',
    'dealVolume',
    'DealVolume',
  )
  if (vol == null) return 0
  if (vol >= 100 && Number.isInteger(vol)) return vol / 10_000
  return vol
}

/** Close/exit fill price from a broker history row. First positive wins —
 * a present-but-zero key means "not reported", never a real zero price. */
export function resolveMtClosePrice(order: RawMtOrder, profile: MtHistoryProfile): number | null {
  return firstPositiveNumMtField(order, profile, 'closePrice', 'ClosePrice')
}

/** When the row says it was closed: epoch milliseconds, or null when no
 * key holds a usable close timestamp. Keys are tried in order and an
 * unusable one (0, empty, unparseable) does not block a later usable key —
 * the same "first usable wins" rule the edge applies. Only positivity
 * matters to callers: an open position echoed into OrderHistory carries no
 * close time (and an epoch-0/`0001-01-01` value means "never closed"), so
 * a non-positive value reports null rather than a fabricated instant. */
export function resolveMtCloseTimeMs(order: RawMtOrder, profile: MtHistoryProfile): number | null {
  for (const key of MT_CLOSE_TIME_KEYS) {
    const v = pickMtField(order, profile, key)
    if (v === null || v === undefined || v === '') continue
    const ms = parseMtInstant(String(v))
    if (ms != null) return ms
  }
  return null
}

/** One timestamp value → epoch ms: a number is epoch seconds below 1e12 and
 * epoch ms at or above it, anything else is parsed as a date string. A naive
 * ISO string (no zone designator — what the bridges send) is read as UTC,
 * not the process's local zone, so the value does not shift with the
 * container's TZ and stays on the same clock as the DB's `closed_at`.
 * Null when it is not a positive instant. */
function parseMtInstant(raw: string): number | null {
  const trimmed = raw.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, '$1T$2')
  const asNum = Number(trimmed)
  if (Number.isFinite(asNum)) {
    if (asNum <= 0) return null
    return asNum >= 1e12 ? asNum : asNum * 1000
  }
  const zoned = NAIVE_ISO_RE.test(trimmed) ? `${trimmed}Z` : trimmed
  const ms = Date.parse(zoned)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

/** ISO-8601 without a zone offset (`2026-09-24T09:51:00.000`, `…:00`). */
const NAIVE_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

function resolveMtDealProfit(order: RawMtOrder, profile: MtHistoryProfile): number | null {
  const p = numMtField(
    order,
    profile,
    'profit',
    'Profit',
    'dealProfit',
    'DealProfit',
    'grossProfit',
    'GrossProfit',
    'closeProfit',
    'CloseProfit',
    ...(profile === 'trades' ? (['freeProfit', 'FreeProfit'] as const) : []),
  )
  if (profile === 'dashboard' || (p != null && p !== 0)) return p

  for (const key of ['dealInternalOut', 'DealInternalOut'] as const) {
    const out = order[key]
    if (!isPlainObject(out)) continue
    const op = numMtField(out, 'trades', 'profit', 'Profit', 'freeProfit', 'FreeProfit')
    if (op != null) return op
  }

  return p
}

/** `netProfit` from sources trusted to describe THIS close: the row itself,
 * its `result`, or the closing deal (`dealInternalOut`). Deliberately not the
 * generic flattened read — `flattenMtOrder` absorbs scalars from every nested
 * object (`dealInternalIn`, `orderInternal`, `position`, …), so an entry-side
 * value could win over the closing one and be persisted as realized P/L.
 * `resolveMtDealProfit` applies the same closing-deal restriction to its own
 * nested fallback for the same reason. */
function trustedNetProfit(order: RawMtOrder): number | null {
  const sources: RawMtOrder[] = [order]
  if (isPlainObject(order.result)) sources.push(order.result as RawMtOrder)
  for (const key of ['dealInternalOut', 'DealInternalOut'] as const) {
    if (isPlainObject(order[key])) sources.push(order[key] as RawMtOrder)
  }
  for (const src of sources) {
    for (const key of ['netProfit', 'NetProfit'] as const) {
      const v = src[key]
      if (v === null || v === undefined || v === '') continue
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

/** Realized profit to persist for a closed trade. Preferred source is an
 * explicit `netProfit` (the position-level net the FxSocket position
 * reader normalizes with `profit: netProfit ?? profit` in
 * `supabase/functions/_shared/fxsocketTrades.ts`), else the resolved deal
 * profit. This is the better P/L figure for a fallback and for copy-limit
 * maths (it can carry swap/commission that a single deal does not), but it
 * is NOT guaranteed to equal what the live dashboard shows: the dashboard's
 * MTAPI OrderHistory path reads only `resolveMtDealProfit`, and its FxSocket
 * closed list reads position history rather than these deals. Treat the two
 * as the same trade's P/L, not as byte-identical figures. */
export function resolveMtStoredProfit(order: RawMtOrder, profile: MtHistoryProfile): number | null {
  const net = trustedNetProfit(order)
  if (net != null) return net
  return resolveMtDealProfit(order, profile)
}

export function resolveMtTicket(order: RawMtOrder, profile: MtHistoryProfile): number {
  const ticket = Number(pickMtField(order, profile, 'ticket', 'Ticket', 'order', 'Order', 'deal', 'Deal') ?? 0)
  return Number.isFinite(ticket) && ticket > 0 ? ticket : 0
}

/** Opening / position ticket on MT5 close deals (differs from the closing
 * deal ticket). Ported from `supabase/functions/_shared/mtTradeFields.ts` —
 * FxSocket `OrderHistory` returns deal rows where `position` is the id the
 * `trades` table stores in `metaapi_order_id`. */
export function resolveMtPositionTicket(
  order: RawMtOrder,
  profile: MtHistoryProfile,
): number | null {
  const flat = profile === 'trades' ? flattenMtOrder(order, 'trades') : order
  for (const key of ['dealInternalIn', 'DealInternalIn', 'position', 'Position'] as const) {
    const nested = flat[key]
    if (!isPlainObject(nested)) continue
    const ticket = resolveMtTicket(nested as RawMtOrder, profile)
    if (ticket > 0) return ticket
  }
  const positionId = Number(
    pickMtField(flat, profile, 'positionId', 'PositionId', 'position', 'Position', 'order', 'Order') ?? 0,
  )
  return Number.isFinite(positionId) && positionId > 0 ? positionId : null
}

/** Close-time keys, same set and order as `MT_CLOSE_TIME_KEYS` in
 * `supabase/functions/_shared/mtTradeFields.ts` (the committed, sanitized
 * payload samples in `docs/mtapi-conformance-sanitized.md` carry
 * `closeTime`). Deliberately WITHOUT the edge's `time`/`Time` fallback: on
 * an open position echoed into OrderHistory `time` is the OPEN time, and
 * accepting it would let floating P/L through as realized profit. */
const MT_CLOSE_TIME_KEYS = [
  'closeTime',
  'CloseTime',
  'close_time',
  'CLOSE_TIME',
  'Close_Time',
  'timeClose',
  'TimeClose',
  'doneTime',
  'DoneTime',
  'time_done',
  'Time_Done',
  'timeDone',
  'TimeDone',
  'timeDoneMsc',
  'TimeDoneMsc',
  'time_done_msc',
  'doneBrokerTime',
  'DoneBrokerTime',
  'historyTime',
  'HistoryTime',
] as const

/** First PRESENT close-time value (used as a dedupe key, where an unusable
 * value still distinguishes two rows). */
function closeTimeKey(order: RawMtOrder, profile: MtHistoryProfile): string {
  const ct = pickMtField(order, profile, ...MT_CLOSE_TIME_KEYS)
  return ct != null ? String(ct) : ''
}

/** First present text value across the keys, read through the same
 * flattening the dashboard's normalizer uses (`pickMtField`), so a value
 * that only exists on a nested deal object is seen here too. */
export function resolveMtText(
  order: RawMtOrder,
  profile: MtHistoryProfile,
  ...keys: string[]
): string {
  const v = pickMtField(order, profile, ...keys)
  if (v === null || v === undefined) return ''
  return String(v).trim()
}

function historyRowKey(order: RawMtOrder, profile: MtHistoryProfile): string {
  const ticket = resolveMtTicket(order, profile)
  if (ticket <= 0) return ''
  if (profile === 'dashboard') return String(ticket)
  const ct = closeTimeKey(order, profile)
  return ct ? `${ticket}:${ct}` : String(ticket)
}

function mergeMtHistoryRow(prev: RawMtOrder, next: RawMtOrder, profile: MtHistoryProfile): RawMtOrder {
  const prevRow = profile === 'trades' ? flattenMtOrder(prev, 'trades') : prev
  const nextRow = profile === 'trades' ? flattenMtOrder(next, 'trades') : next
  const merged: RawMtOrder = { ...prevRow, ...nextRow }

  const prevLots = resolveMtLots(prevRow, profile)
  const nextLots = resolveMtLots(nextRow, profile)
  if (nextLots <= 0 && prevLots > 0) {
    for (const k of ['lots', 'Lots', 'lot', 'volume', 'Volume', 'volumeExt', 'VolumeExt', 'closeLots', 'CloseLots']) {
      if (prevRow[k] != null) merged[k] = prevRow[k]
    }
  }

  const prevProfit = resolveMtDealProfit(prevRow, profile)
  const nextProfit = resolveMtDealProfit(nextRow, profile)
  if ((nextProfit == null || nextProfit === 0) && prevProfit != null && prevProfit !== 0) {
    for (const k of ['profit', 'Profit', 'dealProfit', 'DealProfit', 'grossProfit', 'GrossProfit']) {
      if (prevRow[k] != null) merged[k] = prevRow[k]
    }
  }

  return merged
}

export function ingestMtHistoryRows(
  target: Map<string, RawMtOrder>,
  rows: unknown[],
  profile: MtHistoryProfile,
): void {
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const o = profile === 'trades' ? flattenMtOrder(row, 'trades') : (row as RawMtOrder)
    const key = historyRowKey(o, profile)
    if (!key) continue
    const prev = target.get(key)
    target.set(key, prev ? mergeMtHistoryRow(prev, o, profile) : o)
  }
}
