/** Client-side MT deal/order timestamp extraction (mirrors edge mtTradeFields.ts). */

type RawMtOrder = Record<string, unknown>

function isPlainObject(v: unknown): v is RawMtOrder {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

function scalarValue(v: unknown): boolean {
  return v !== null && v !== undefined && typeof v !== 'object'
}

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

const MT_NESTED_SKIP_VOLUME_ABSORB = new Set([
  'dealInternalIn',
  'DealInternalIn',
  'position',
  'Position',
])

const MT_LOT_VOLUME_FIELD_NAMES = new Set([
  'lots', 'Lots', 'lot', 'Lot',
  'volume', 'Volume', 'volumeExt', 'VolumeExt',
  'volumeLots', 'VolumeLots', 'volume_lots',
  'volumeClosed', 'VolumeClosed', 'closeVolume', 'CloseVolume',
  'closeLots', 'CloseLots', 'requestLots', 'RequestLots',
  'requestVolume', 'RequestVolume', 'dealVolume', 'DealVolume',
])

export function flattenMtOrder(row: unknown): RawMtOrder {
  if (!isPlainObject(row)) return {}
  const flat: RawMtOrder = { ...row }

  const absorb = (src: RawMtOrder, skipVolume = false) => {
    for (const [k, v] of Object.entries(src)) {
      if (!scalarValue(v)) continue
      if (skipVolume && MT_LOT_VOLUME_FIELD_NAMES.has(k)) continue
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
    if (isPlainObject(nested)) {
      absorb(nested, MT_NESTED_SKIP_VOLUME_ABSORB.has(key))
    }
  }

  return flat
}

export function pickMtField(order: RawMtOrder, ...keys: string[]): unknown {
  const flat = flattenMtOrder(order)
  for (const k of keys) {
    if (flat[k] !== undefined && flat[k] !== null) return flat[k]
  }
  return undefined
}

export function epochMsFromUnknown(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v < 1e12 ? v * 1000 : v
  }
  if (typeof v !== 'string') return null

  const trimmed = v.trim()
  if (!trimmed) return null

  if (/^\d{10,13}$/.test(trimmed)) {
    const n = Number(trimmed)
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n
  }

  const mtBroker = trimmed.match(
    /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?)?$/,
  )
  if (mtBroker) {
    const [, y, mo, d, h = '00', mi = '00', s = '00', ms] = mtBroker
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${ms ? `.${ms.padEnd(3, '0').slice(0, 3)}` : ''}`
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }

  if (trimmed.includes('T')) {
    const isoParsed = Date.parse(trimmed)
    if (Number.isFinite(isoParsed)) return isoParsed
  }

  const normalized = trimmed.includes('T')
    ? trimmed.replace(/\./g, '-')
    : trimmed.replace(/\./g, '-').replace(' ', 'T')
  let parsed = Date.parse(normalized)
  if (Number.isFinite(parsed)) return parsed

  if (!/[zZ]|[+-]\d{2}/.test(trimmed)) {
    parsed = Date.parse(`${normalized}Z`)
    if (Number.isFinite(parsed)) return parsed
  }

  return null
}

function timestampIsoFromFields(order: RawMtOrder, keys: string[]): string | null {
  for (const k of keys) {
    const ms = epochMsFromUnknown(pickMtField(order, k))
    if (ms != null) return new Date(ms).toISOString()
  }
  return null
}

const MT_OPEN_TIME_KEYS = [
  'openTime', 'OpenTime', 'open_time', 'OPEN_TIME', 'Open_Time',
  'timeOpen', 'TimeOpen',
  'timeSetup', 'TimeSetup', 'time_setup', 'Time_Setup', 'setupTime', 'SetupTime',
  'timeSetupMsc', 'TimeSetupMsc', 'time_setup_msc',
  'brokerTime', 'BrokerTime',
  'created', 'Created',
] as const

const MT_CLOSE_TIME_KEYS = [
  'closeTime', 'CloseTime', 'close_time', 'CLOSE_TIME', 'Close_Time',
  'timeClose', 'TimeClose',
  'doneTime', 'DoneTime', 'time_done', 'Time_Done', 'timeDone', 'TimeDone',
  'timeDoneMsc', 'TimeDoneMsc', 'time_done_msc',
  'doneBrokerTime', 'DoneBrokerTime',
  'historyTime', 'HistoryTime',
] as const

/** Opening / setup time for a deal or open order. */
export function resolveMtOpenTimestamp(order: RawMtOrder): string | null {
  const direct = timestampIsoFromFields(order, [...MT_OPEN_TIME_KEYS])
  if (direct) return direct

  const flat = flattenMtOrder(order)
  for (const key of ['dealInternalIn', 'DealInternalIn', 'position', 'Position'] as const) {
    const nested = flat[key]
    if (!isPlainObject(nested)) continue
    const nestedOpen = timestampIsoFromFields(nested as RawMtOrder, [...MT_OPEN_TIME_KEYS, 'time', 'Time'])
    if (nestedOpen) return nestedOpen
  }

  return findDeepTimestamp(order, [...MT_OPEN_TIME_KEYS])
}

/** OpenedOrders / live positions — `time` is open time, not deal close time. */
export function resolveMtLiveOpenTimestamp(order: RawMtOrder): string | null {
  const direct = resolveMtOpenTimestamp(order)
  if (direct) return direct
  const fromTime = timestampIsoFromFields(order, ['time', 'Time'])
  if (fromTime) return fromTime
  return findDeepTimestamp(order, [...MT_OPEN_TIME_KEYS, 'time', 'Time'])
}

/** Close / execution time (FxSocket OrderHistory deals use `time`). */
export function resolveMtCloseTimestamp(order: RawMtOrder): string | null {
  const close = timestampIsoFromFields(order, [...MT_CLOSE_TIME_KEYS])
  if (close) return close
  const dealTime = timestampIsoFromFields(order, ['time', 'Time'])
  if (dealTime) return dealTime
  return findDeepTimestamp(order, [...MT_CLOSE_TIME_KEYS, 'time', 'Time'])
}

function findDeepTimestamp(obj: unknown, keys: string[], depth = 0): string | null {
  if (depth > 5 || !isPlainObject(obj)) return null
  for (const k of keys) {
    const ms = epochMsFromUnknown(pickMtField(obj as RawMtOrder, k))
    if (ms != null) return new Date(ms).toISOString()
  }
  for (const v of Object.values(obj)) {
    if (!isPlainObject(v)) continue
    const found = findDeepTimestamp(v, keys, depth + 1)
    if (found) return found
  }
  return null
}

export function resolveMtTicket(order: RawMtOrder): number {
  const ticket = Number(
    pickMtField(
      order,
      'ticket',
      'Ticket',
      'ticketNumber',
      'TicketNumber',
      'dealTicket',
      'DealTicket',
      'deal',
      'Deal',
      'order',
      'Order',
    ) ?? 0,
  )
  return Number.isFinite(ticket) && ticket > 0 ? ticket : 0
}

/** @deprecated Prefer resolveMtPositionTicket for MT5 deal/position matching. */
export function resolveMtPositionId(order: RawMtOrder): number {
  return resolveMtPositionTicket(order) ?? 0
}

/** Opening / position ticket on MT5 close deals (differs from the closing deal ticket). */
export function resolveMtPositionTicket(order: RawMtOrder): number | null {
  const flat = flattenMtOrder(order)
  for (const key of ['dealInternalIn', 'DealInternalIn', 'position', 'Position'] as const) {
    const nested = flat[key]
    if (!isPlainObject(nested)) continue
    const ticket = resolveMtTicket(nested as RawMtOrder)
    if (ticket > 0) return ticket
  }
  const positionId = Number(
    pickMtField(flat, 'positionId', 'PositionId', 'position_id', 'order', 'Order') ?? 0,
  )
  return Number.isFinite(positionId) && positionId > 0 ? positionId : null
}
