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

function resolveMtLots(order: RawMtOrder, profile: MtHistoryProfile): number {
  const keys =
    profile === 'trades'
      ? ['lots', 'Lots', 'lot', 'Lot', 'volumeLots', 'VolumeLots', 'closeLots', 'CloseLots', 'requestLots', 'RequestLots']
      : ['lots', 'Lots', 'lot', 'Lot', 'volumeLots', 'VolumeLots']

  const direct = numMtField(order, profile, ...keys)
  if (direct != null && direct > 0) return direct

  const volExt = numMtField(order, profile, 'volumeExt', 'VolumeExt')
  if (volExt != null && volExt > 0) {
    if (volExt >= 1_000_000) return volExt / 100_000_000
    if (volExt >= 10_000) return volExt / 10_000
  }

  const vol = numMtField(
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
  if (vol == null || vol <= 0) return 0
  if (vol >= 100 && Number.isInteger(vol)) return vol / 10_000
  return vol
}

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

function resolveMtTicket(order: RawMtOrder, profile: MtHistoryProfile): number {
  const ticket = Number(pickMtField(order, profile, 'ticket', 'Ticket', 'order', 'Order', 'deal', 'Deal') ?? 0)
  return Number.isFinite(ticket) && ticket > 0 ? ticket : 0
}

function closeTimeKey(order: RawMtOrder, profile: MtHistoryProfile): string {
  const ct = pickMtField(
    order,
    profile,
    'closeTime',
    'CloseTime',
    'close_time',
    'timeClose',
    'TimeClose',
    'doneTime',
    'DoneTime',
    'historyTime',
    'HistoryTime',
  )
  return ct != null ? String(ct) : ''
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
