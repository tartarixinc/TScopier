/** Shared MT order/deal field extraction for trades API + history merge. */

export type RawMtOrder = Record<string, unknown>

/** Dashboard charts: position-level merge. Trades list: deal-level + nested deal fields. */
export type MtHistoryProfile = "dashboard" | "trades"

const MT_DEAL_NESTED_OBJECTS = [
  "dealInternalOut",
  "DealInternalOut",
  "dealInternalIn",
  "DealInternalIn",
  "orderInternal",
  "OrderInternal",
  "ex",
  "Ex",
  "deal",
  "Deal",
  "position",
  "Position",
  "result",
  "Result",
] as const

/** Do not hoist position/open-leg size onto each OUT deal row. */
const MT_NESTED_SKIP_VOLUME_ABSORB = new Set([
  "dealInternalIn",
  "DealInternalIn",
  "position",
  "Position",
])

const MT_LOT_VOLUME_FIELD_NAMES = new Set([
  "lots", "Lots", "lot", "Lot",
  "volume", "Volume", "volumeExt", "VolumeExt",
  "volumeLots", "VolumeLots", "volume_lots",
  "volumeClosed", "VolumeClosed", "closeVolume", "CloseVolume",
  "closeLots", "CloseLots", "requestLots", "RequestLots",
  "requestVolume", "RequestVolume", "dealVolume", "DealVolume",
])

function isPlainObject(v: unknown): v is RawMtOrder {
  return v != null && typeof v === "object" && !Array.isArray(v)
}

function scalarValue(v: unknown): boolean {
  return v !== null && v !== undefined && typeof v !== "object"
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

/**
 * Trades list only: hoist nested deal fields when top-level volume/profit are 0.
 * Do not use for dashboard charts — it can copy OUT-deal profit onto every leg.
 */
export function flattenMtOrder(
  row: unknown,
  profile: MtHistoryProfile = "trades",
): RawMtOrder {
  if (!isPlainObject(row)) return {}
  if (profile === "dashboard") return shallowUnwrapResult(row)

  const flat: RawMtOrder = { ...row }

  const absorb = (src: RawMtOrder, skipVolume = false) => {
    for (const [k, v] of Object.entries(src)) {
      if (!scalarValue(v)) continue
      if (skipVolume && MT_LOT_VOLUME_FIELD_NAMES.has(k)) continue
      const cur = flat[k]
      if (cur === undefined || cur === null || cur === "") {
        flat[k] = v
        continue
      }
      if (typeof cur === "number" && cur === 0 && typeof v === "number" && v !== 0) {
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

  const ticket = Number(flat.ticket ?? flat.Ticket ?? 0)
  if (!(ticket > 0)) {
    const tn = Number(
      flat.ticketNumber ?? flat.TicketNumber ?? flat.dealTicket ?? flat.DealTicket ?? 0,
    )
    if (tn > 0) flat.ticket = tn
  }

  return flat
}

export function pickMtField(
  order: RawMtOrder,
  profile: MtHistoryProfile,
  ...keys: string[]
): unknown {
  if (profile === "trades") {
    const flat = flattenMtOrder(order, "trades")
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

function numMtField(
  order: RawMtOrder,
  profile: MtHistoryProfile,
  ...keys: string[]
): number | null {
  const v = pickMtField(order, profile, ...keys)
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function epochMsFromUnknown(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return v < 1e12 ? v * 1000 : v
  }
  if (typeof v !== "string") return null

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
    const [, y, mo, d, h = "00", mi = "00", s = "00", ms] = mtBroker
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${ms ? `.${ms.padEnd(3, "0").slice(0, 3)}` : ""}`
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }

  // ISO 8601 (incl. FxSocket PositionHistory `2026-06-02T11:13:04.000Z`) — parse before MT dot normalization.
  if (trimmed.includes("T")) {
    const isoParsed = Date.parse(trimmed)
    if (Number.isFinite(isoParsed)) return isoParsed
  }

  const normalized = trimmed.includes("T")
    ? trimmed.replace(/\./g, "-")
    : trimmed.replace(/\./g, "-").replace(" ", "T")
  let parsed = Date.parse(normalized)
  if (Number.isFinite(parsed)) return parsed

  if (!/[zZ]|[+-]\d{2}/.test(trimmed)) {
    parsed = Date.parse(`${normalized}Z`)
    if (Number.isFinite(parsed)) return parsed
  }

  return null
}

function timestampIsoFromFields(
  order: RawMtOrder,
  profile: MtHistoryProfile,
  keys: string[],
): string | null {
  for (const k of keys) {
    const ms = epochMsFromUnknown(pickMtField(order, profile, k))
    if (ms != null) return new Date(ms).toISOString()
  }
  return null
}

const MT_OPEN_TIME_KEYS = [
  "openTime", "OpenTime", "open_time", "OPEN_TIME", "Open_Time",
  "timeOpen", "TimeOpen",
  "timeSetup", "TimeSetup", "time_setup", "Time_Setup", "setupTime", "SetupTime",
  "timeSetupMsc", "TimeSetupMsc", "time_setup_msc",
  "brokerTime", "BrokerTime",
  "created", "Created",
] as const

const MT_CLOSE_TIME_KEYS = [
  "closeTime", "CloseTime", "close_time", "CLOSE_TIME", "Close_Time",
  "timeClose", "TimeClose",
  "doneTime", "DoneTime", "time_done", "Time_Done", "timeDone", "TimeDone",
  "timeDoneMsc", "TimeDoneMsc", "time_done_msc",
  "doneBrokerTime", "DoneBrokerTime",
  "historyTime", "HistoryTime",
] as const

/** Opening / setup time for a deal or open order. */
export function resolveMtOpenTimestamp(
  order: RawMtOrder,
  profile: MtHistoryProfile,
): string | null {
  const direct = timestampIsoFromFields(order, profile, [...MT_OPEN_TIME_KEYS])
  if (direct) return direct

  if (profile !== "trades") {
    return timestampIsoFromFields(order, profile, ["time", "Time"])
  }

  const flat = flattenMtOrder(order, "trades")
  for (const key of ["dealInternalIn", "DealInternalIn", "position", "Position"] as const) {
    const nested = flat[key]
    if (!isPlainObject(nested)) continue
    const nestedOpen = timestampIsoFromFields(
      nested as RawMtOrder,
      profile,
      [...MT_OPEN_TIME_KEYS, "time", "Time"],
    )
    if (nestedOpen) return nestedOpen
  }

  return findDeepTimestamp(order, profile, [...MT_OPEN_TIME_KEYS])
}

/** OpenedOrders / live positions — top-level `time` is open time, not deal close time. */
export function resolveMtLiveOpenTimestamp(
  order: RawMtOrder,
  profile: MtHistoryProfile,
): string | null {
  const direct = resolveMtOpenTimestamp(order, profile)
  if (direct) return direct
  const fromTime = timestampIsoFromFields(order, profile, ["time", "Time"])
  if (fromTime) return fromTime
  return findDeepTimestamp(order, profile, [...MT_OPEN_TIME_KEYS, "time", "Time"])
}

function findDeepTimestamp(
  obj: unknown,
  profile: MtHistoryProfile,
  keys: string[],
  depth = 0,
): string | null {
  if (depth > 5 || !isPlainObject(obj)) return null
  for (const k of keys) {
    const ms = epochMsFromUnknown(pickMtField(obj as RawMtOrder, profile, k))
    if (ms != null) return new Date(ms).toISOString()
  }
  for (const v of Object.values(obj)) {
    if (!isPlainObject(v)) continue
    const found = findDeepTimestamp(v, profile, keys, depth + 1)
    if (found) return found
  }
  return null
}

/** Close / execution time for a deal (MT5 history rows often only expose `time`). */
export function resolveMtCloseTimestamp(
  order: RawMtOrder,
  profile: MtHistoryProfile,
): string | null {
  const close = timestampIsoFromFields(order, profile, [...MT_CLOSE_TIME_KEYS])
  if (close) return close
  const dealTime = timestampIsoFromFields(order, profile, ["time", "Time"])
  if (dealTime) return dealTime
  return findDeepTimestamp(order, profile, [...MT_CLOSE_TIME_KEYS, "time", "Time"])
}

function numFromRawFields(order: RawMtOrder, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = order[k]
    if (v === null || v === undefined || v === "") continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function mtVolumeToLots(vol: number): number {
  if (vol <= 0) return 0
  if (vol >= 1_000_000) return vol / 100_000_000
  if (vol >= 100 && Number.isInteger(vol)) return vol / 10_000
  return vol
}

/** Convert MT volume / lots fields to standard lots (0.01 = 0.01 lot). */
export function resolveMtLots(order: RawMtOrder, profile: MtHistoryProfile): number {
  if (profile === "trades") {
    const rawLots = numFromRawFields(
      order,
      "closeLots", "CloseLots", "lots", "Lots", "lot", "Lot",
      "volumeLots", "VolumeLots", "volume_lots", "requestLots", "RequestLots",
    )
    if (rawLots != null && rawLots > 0) return rawLots

    const rawVol = numFromRawFields(
      order,
      "volumeClosed", "VolumeClosed", "closeVolume", "CloseVolume",
      "volume", "Volume", "dealVolume", "DealVolume",
      "requestVolume", "RequestVolume", "volumeExt", "VolumeExt",
    )
    if (rawVol != null && rawVol > 0) return mtVolumeToLots(rawVol)
  }

  const keys = profile === "trades"
    ? [
      "closeLots", "CloseLots", "lots", "Lots", "lot", "Lot",
      "volumeLots", "VolumeLots", "volume_lots", "requestLots", "RequestLots",
    ]
    : ["lots", "Lots", "lot", "Lot", "volumeLots", "VolumeLots", "volume_lots"]

  const direct = numMtField(order, profile, ...keys)
  if (direct != null && direct > 0) return direct

  const volExt = numMtField(order, profile, "volumeExt", "VolumeExt")
  if (volExt != null && volExt > 0) return mtVolumeToLots(volExt)

  const vol = numMtField(
    order,
    profile,
    "volumeClosed",
    "VolumeClosed",
    "closeVolume",
    "CloseVolume",
    "volume",
    "Volume",
    "requestVolume",
    "RequestVolume",
    "dealVolume",
    "DealVolume",
  )
  if (vol == null || vol <= 0) return 0
  return mtVolumeToLots(vol)
}

/** Deal profit from MT row (terminal profit column). */
export function resolveMtDealProfit(
  order: RawMtOrder,
  profile: MtHistoryProfile,
): number | null {
  const p = numMtField(
    order,
    profile,
    "profit",
    "Profit",
    "dealProfit",
    "DealProfit",
    "grossProfit",
    "GrossProfit",
    "closeProfit",
    "CloseProfit",
    "realizedProfit",
    "RealizedProfit",
    ...(profile === "trades" ? ["freeProfit", "FreeProfit"] as const : []),
  )
  if (profile === "dashboard" || (p != null && p !== 0)) return p

  for (const key of ["dealInternalOut", "DealInternalOut"] as const) {
    const out = order[key]
    if (!isPlainObject(out)) continue
    const op = numMtField(out, "trades", "profit", "Profit", "freeProfit", "FreeProfit")
    if (op != null) return op
  }

  return p
}

export function resolveMtTicket(order: RawMtOrder, profile: MtHistoryProfile): number {
  const ticket = Number(
    pickMtField(order, profile, "ticket", "Ticket", "order", "Order", "deal", "Deal") ?? 0,
  )
  return Number.isFinite(ticket) && ticket > 0 ? ticket : 0
}

/** Opening / position ticket on MT5 close deals (differs from the closing deal ticket). */
export function resolveMtPositionTicket(
  order: RawMtOrder,
  profile: MtHistoryProfile,
): number | null {
  const flat = profile === "trades" ? flattenMtOrder(order, "trades") : order
  for (const key of ["dealInternalIn", "DealInternalIn", "position", "Position"] as const) {
    const nested = flat[key]
    if (!isPlainObject(nested)) continue
    const ticket = resolveMtTicket(nested as RawMtOrder, profile)
    if (ticket > 0) return ticket
  }
  const positionId = Number(
    pickMtField(flat, profile, "positionId", "PositionId", "position", "Position", "order", "Order") ?? 0,
  )
  return Number.isFinite(positionId) && positionId > 0 ? positionId : null
}

function closeTimeKey(order: RawMtOrder, profile: MtHistoryProfile): string {
  const ct = pickMtField(
    order,
    profile,
    "closeTime",
    "CloseTime",
    "close_time",
    "CLOSE_TIME",
    "timeClose",
    "TimeClose",
    "doneTime",
    "DoneTime",
    "historyTime",
    "HistoryTime",
    "time",
    "Time",
  )
  return ct != null ? String(ct) : ""
}

export function historyRowKey(order: RawMtOrder, profile: MtHistoryProfile): string {
  const ticket = resolveMtTicket(order, profile)
  if (ticket <= 0) return ""
  if (profile === "dashboard") return String(ticket)
  const ct = closeTimeKey(order, profile)
  if (ct) return `${ticket}:${ct}`
  const vol = numFromRawFields(
    order,
    "volume", "Volume", "volumeClosed", "VolumeClosed", "lots", "Lots",
  )
  if (vol != null && vol > 0) return `${ticket}:v${vol}`
  return String(ticket)
}

/** Merge two raw history rows; prefer non-zero lots and non-zero deal profit. */
export function mergeMtHistoryRow(
  prev: RawMtOrder,
  next: RawMtOrder,
  profile: MtHistoryProfile,
): RawMtOrder {
  const prevRow = profile === "trades" ? flattenMtOrder(prev, "trades") : prev
  const nextRow = profile === "trades" ? flattenMtOrder(next, "trades") : next
  const merged: RawMtOrder = { ...prevRow, ...nextRow }

  const prevLots = resolveMtLots(prevRow, profile)
  const nextLots = resolveMtLots(nextRow, profile)
  if (nextLots <= 0 && prevLots > 0) {
    for (const k of ["lots", "Lots", "lot", "volume", "Volume", "volumeExt", "VolumeExt", "closeLots", "CloseLots"]) {
      if (prevRow[k] != null) merged[k] = prevRow[k]
    }
  }

  const prevProfit = resolveMtDealProfit(prevRow, profile)
  const nextProfit = resolveMtDealProfit(nextRow, profile)
  if ((nextProfit == null || nextProfit === 0) && prevProfit != null && prevProfit !== 0) {
    for (const k of ["profit", "Profit", "dealProfit", "DealProfit", "grossProfit", "GrossProfit"]) {
      if (prevRow[k] != null) merged[k] = prevRow[k]
    }
    if (profile === "trades") {
      for (const key of ["dealInternalOut", "DealInternalOut"] as const) {
        if (isPlainObject(prevRow[key])) merged[key] = prevRow[key]
      }
    }
  }

  for (const k of ["swap", "Swap", "commission", "Commission", "fee", "Fee"]) {
    if (merged[k] == null && prevRow[k] != null) merged[k] = prevRow[k]
  }

  if (!pickMtField(merged, profile, "closeTime", "CloseTime", "close_time", "CLOSE_TIME", "timeClose", "TimeClose", "time", "Time")) {
    const ct = pickMtField(
      prevRow,
      profile,
      "closeTime",
      "CloseTime",
      "close_time",
      "CLOSE_TIME",
      "timeClose",
      "TimeClose",
      "time",
      "Time",
    )
    if (ct) merged.closeTime = ct
  }

  if (!pickMtField(merged, profile, "openTime", "OpenTime", "open_time", "OPEN_TIME", "timeOpen", "TimeOpen")) {
    const ot = pickMtField(prevRow, profile, "openTime", "OpenTime", "open_time", "OPEN_TIME", "timeOpen", "TimeOpen")
    if (ot) merged.openTime = ot
  }

  if (!pickMtField(merged, profile, "symbol", "Symbol") && pickMtField(prevRow, profile, "symbol", "Symbol")) {
    merged.symbol = pickMtField(prevRow, profile, "symbol", "Symbol")
  }

  return merged
}

type MtDirection = "buy" | "sell" | ""

function invertMtDirection(direction: MtDirection): MtDirection {
  if (direction === "buy") return "sell"
  if (direction === "sell") return "buy"
  return ""
}

function directionFromTypeString(raw: string): { direction: MtDirection; label: string } | null {
  const cleaned = raw.replace(/^(OrderType_|DealType_|DEAL_TYPE_|ORDER_TYPE_|POSITION_TYPE_|PositionType_)/i, "").trim()
  if (!cleaned) return null
  if (/^\d+$/.test(cleaned)) return null
  const lower = cleaned.toLowerCase()
  const direction: MtDirection =
    lower.startsWith("buy") ? "buy"
    : lower.startsWith("sell") ? "sell"
    : lower.includes("buy") ? "buy"
    : lower.includes("sell") ? "sell"
    : ""
  const label = cleaned.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim()
  return { direction, label }
}

function directionFromOrderRow(order: RawMtOrder, profile: MtHistoryProfile): MtDirection {
  const flat = profile === "trades" ? flattenMtOrder(order, "trades") : order
  for (const key of [
    "type", "Type", "orderType", "OrderType", "dealType", "DealType", "cmdString", "action", "Action",
  ]) {
    const v = pickMtField(flat, profile, key)
    if (typeof v === "string" && v.trim()) {
      const parsed = directionFromTypeString(v)
      if (parsed?.direction) return parsed.direction
    }
  }
  return ""
}

/** MT5 deal entry: 0=in, 1=out, 3=out by; strings like DEAL_ENTRY_OUT / Out. */
function parseMtDealEntry(order: RawMtOrder, profile: MtHistoryProfile): "in" | "out" | "unknown" {
  const flat = profile === "trades" ? flattenMtOrder(order, "trades") : order
  const v = pickMtField(
    flat,
    profile,
    "entry",
    "Entry",
    "dealEntry",
    "DealEntry",
    "deal_entry",
    "orderEntry",
    "OrderEntry",
  )
  if (typeof v === "string" && v.trim()) {
    const lower = v.toLowerCase().replace(/^(deal_entry_|dealentry_)/i, "")
    if (lower.includes("out_by") || lower === "out" || lower.endsWith("_out") || lower.includes(" exit")) {
      return "out"
    }
    if (lower.includes("inout") || lower.includes("in_out")) return "unknown"
    if (lower.includes("in") || lower === "in" || lower.endsWith("_in")) return "in"
  }
  if (typeof v === "number") {
    if (v === 1 || v === 3) return "out"
    if (v === 0) return "in"
  }
  return "unknown"
}

function labelForPositionDirection(direction: MtDirection, typeLabel: string): string {
  if (direction !== "buy" && direction !== "sell") return typeLabel
  const wantsDealPrefix = /deal/i.test(typeLabel)
  if (direction === "buy") return wantsDealPrefix ? "Deal Buy" : "Buy"
  return wantsDealPrefix ? "Deal Sell" : "Sell"
}

/** Position side from entry vs SL/TP geometry (buy: SL below, TP above entry). */
export function inferDirectionFromStopPrices(
  entry: number | null | undefined,
  sl: number | null | undefined,
  tp: number | null | undefined,
): MtDirection {
  if (entry == null || !Number.isFinite(entry) || entry <= 0) return ""
  let buyVotes = 0
  let sellVotes = 0
  if (sl != null && Number.isFinite(sl) && sl > 0) {
    if (sl < entry) buyVotes++
    else if (sl > entry) sellVotes++
  }
  if (tp != null && Number.isFinite(tp) && tp > 0) {
    if (tp > entry) buyVotes++
    else if (tp < entry) sellVotes++
  }
  if (buyVotes > sellVotes) return "buy"
  if (sellVotes > buyVotes) return "sell"
  return ""
}

/** When deal type says sell but SL/TP imply buy (OUT deal on long), trust geometry. */
export function reconcileTradeDirectionWithStops(
  direction: MtDirection,
  entry: number | null,
  sl: number | null,
  tp: number | null,
): { direction: MtDirection; type_label: string } {
  const inferred = inferDirectionFromStopPrices(entry, sl, tp)
  let finalDir = direction
  if (inferred && (!finalDir || finalDir !== inferred)) finalDir = inferred
  if (finalDir === "buy") return { direction: "buy", type_label: "Buy" }
  if (finalDir === "sell") return { direction: "sell", type_label: "Sell" }
  return { direction: finalDir, type_label: direction ? labelForPositionDirection(direction, "Buy") : "" }
}

/**
 * Deal-level history (trades profile) uses closing deals: deal type is the exit action,
 * opposite of position side. Prefer opening-leg nested fields; invert on OUT deals.
 */
export function adjustMtTradesPositionDirection(
  order: RawMtOrder,
  profile: MtHistoryProfile,
  resolved: { direction: MtDirection; type_label: string },
): { direction: MtDirection; type_label: string } {
  if (profile !== "trades") return resolved

  const flat = flattenMtOrder(order, "trades")

  for (const key of ["dealInternalIn", "DealInternalIn", "position", "Position"] as const) {
    const nested = flat[key]
    if (!isPlainObject(nested)) continue
    const fromNested = directionFromOrderRow(nested as RawMtOrder, "trades")
    if (fromNested) {
      return {
        direction: fromNested,
        type_label: labelForPositionDirection(fromNested, resolved.type_label),
      }
    }
  }

  let { direction, type_label } = resolved
  const entry = parseMtDealEntry(order, profile)

  if (entry === "out" && (direction === "buy" || direction === "sell")) {
    direction = invertMtDirection(direction)
    type_label = labelForPositionDirection(direction, type_label)
  }

  return { direction, type_label }
}

export function ingestMtHistoryRows(
  target: Map<string, RawMtOrder>,
  rows: unknown[],
  profile: MtHistoryProfile,
): void {
  for (const row of rows) {
    if (!row || typeof row !== "object") continue
    const raw = row as RawMtOrder
    const key = historyRowKey(raw, profile)
    if (!key) continue
    const prev = target.get(key)
    target.set(key, prev ? mergeMtHistoryRow(prev, raw, profile) : raw)
  }
}
