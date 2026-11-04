/**
 * Binance USD-M futures REST helpers for the edge function.
 * Signed requests send `X-MBX-APIKEY` and an HMAC-SHA256 signature of the query string.
 * https://developers.binance.com/docs/derivatives/usds-margined-futures
 */

export type BinanceEnvironment = "demo" | "live"

export const BINANCE_HOSTS: Record<BinanceEnvironment, string> = {
  live: "https://fapi.binance.com",
  demo: "https://demo-fapi.binance.com",
}

export interface BinanceKeys {
  apiKey: string
  apiSecret: string
  environment: BinanceEnvironment
}

export class BinanceError extends Error {
  constructor(message: string, readonly code: number | null, readonly status: number) {
    super(message)
  }
}

type Params = Record<string, string | number | boolean | null | undefined>

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    : []
}

export function binanceEnvironmentOf(value: unknown): BinanceEnvironment {
  return String(value ?? "").trim().toLowerCase() === "live" ? "live" : "demo"
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

export async function binanceFingerprint(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16)
}

function query(params: Params): string {
  const pairs: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return pairs.join("&")
}

export function friendlyBinanceError(error: unknown): string {
  if (error instanceof BinanceError) {
    if (error.code === -2015 || error.code === -2014 || error.code === -1022) {
      return "Binance rejected this API key. Check the key and secret, that Futures trading is enabled for it, and any IP restriction."
    }
    if (error.code === -2008) return "Binance does not recognise this API key for the selected environment."
    return error.message
  }
  return error instanceof Error ? error.message : "Binance request failed"
}

async function request<T>(
  keys: BinanceKeys,
  method: "GET" | "POST",
  path: string,
  params: Params,
  signed: boolean,
): Promise<T> {
  const all: Params = { ...params }
  if (signed) {
    all.recvWindow = 10_000
    all.timestamp = Date.now()
  }
  let qs = query(all)
  if (signed) qs = `${qs}&signature=${await hmacHex(keys.apiSecret, qs)}`
  const response = await fetch(`${BINANCE_HOSTS[keys.environment]}${path}${qs ? `?${qs}` : ""}`, {
    method,
    headers: signed ? { "X-MBX-APIKEY": keys.apiKey } : {},
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const row = body && typeof body === "object" ? body as Record<string, unknown> : {}
    const message = typeof row.msg === "string" && row.msg ? row.msg : `Binance HTTP ${response.status}`
    throw new BinanceError(message, typeof row.code === "number" ? row.code : null, response.status)
  }
  return body as T
}

export interface BinanceSnapshot {
  balance: number | undefined
  equity: number | undefined
  profit: number | undefined
  available: number | undefined
  currency: string
  canTrade: boolean
  openTrades: number
  status: Record<string, unknown>
}

export async function binanceAccount(keys: BinanceKeys): Promise<BinanceSnapshot> {
  const account = await request<Record<string, unknown>>(keys, "GET", "/fapi/v2/account", {}, true)
  const canTrade = account.canTrade !== false
  const positions = asRows(account.positions).filter(row => (finite(row.positionAmt) ?? 0) !== 0)
  return {
    balance: finite(account.totalWalletBalance),
    equity: finite(account.totalMarginBalance),
    profit: finite(account.totalUnrealizedProfit),
    available: finite(account.availableBalance),
    currency: "USDT",
    canTrade,
    openTrades: positions.length,
    status: {
      status: "ready",
      terminal: { alive: true },
      broker: { connected: true, server: keys.environment === "live" ? "Binance Futures" : "Binance Futures Demo" },
      account: { loggedIn: true, tradeAllowed: canTrade, currency: "USDT", type: keys.environment === "live" ? "Live" : "Demo" },
      bridge: { tradeEaReady: true, symbolsSynced: true },
    },
  }
}

export async function binanceQuote(keys: BinanceKeys, symbol: string): Promise<{ symbol: string; bid: number; ask: number }> {
  const wanted = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
  const candidates = [wanted, wanted.endsWith("USD") ? `${wanted}T` : `${wanted}USDT`]
  for (const candidate of candidates) {
    try {
      const body = await request<Record<string, unknown>>(keys, "GET", "/fapi/v1/ticker/bookTicker", { symbol: candidate }, false)
      const bid = finite(body.bidPrice)
      const ask = finite(body.askPrice)
      if (bid && ask) return { symbol: candidate, bid, ask }
    } catch {
      // Try the next spelling.
    }
  }
  throw new Error(`Symbol ${symbol} is not available on Binance futures`)
}

type PositionRow = {
  symbol: string
  positionSide: string
  amount: number
  entryPrice: number
  markPrice: number
  unrealized: number
  leverage: number | undefined
  marginType: string
  liquidationPrice: number | undefined
  updateTime: number | undefined
}

export async function binancePositions(keys: BinanceKeys): Promise<PositionRow[]> {
  const rows = asRows(await request<unknown>(keys, "GET", "/fapi/v2/positionRisk", {}, true))
  return rows
    .map(row => ({
      symbol: String(row.symbol ?? ""),
      positionSide: String(row.positionSide ?? "BOTH").toUpperCase(),
      amount: finite(row.positionAmt) ?? 0,
      entryPrice: finite(row.entryPrice) ?? 0,
      markPrice: finite(row.markPrice) ?? 0,
      unrealized: finite(row.unRealizedProfit) ?? 0,
      leverage: finite(row.leverage),
      marginType: String(row.marginType ?? ""),
      liquidationPrice: (() => {
        const price = finite(row.liquidationPrice)
        return price && price > 0 ? price : undefined
      })(),
      updateTime: finite(row.updateTime),
    }))
    .filter(row => row.symbol && row.amount !== 0)
}

/** Open positions as the broker book rows the dashboard reads. */
export async function binanceOpenedOrders(keys: BinanceKeys): Promise<Record<string, unknown>[]> {
  const positions = await binancePositions(keys)
  return positions.map(position => ({
    ticket: positionTicket(position),
    symbol: position.symbol,
    operation: positionDirection(position) === "sell" ? "Sell" : "Buy",
    lots: Math.abs(position.amount),
    openPrice: position.entryPrice || undefined,
    profit: position.unrealized,
    liquidationPrice: position.liquidationPrice,
    leverage: position.leverage,
    marginType: position.marginType,
    comment: "",
  }))
}

export async function binanceLiveBook(keys: BinanceKeys): Promise<{
  balance: number | undefined
  equity: number | undefined
  profit: number | undefined
  currency: string
  openTrades: number
}> {
  const snapshot = await binanceAccount(keys)
  return {
    balance: snapshot.balance,
    equity: snapshot.equity,
    profit: snapshot.profit,
    currency: snapshot.currency,
    openTrades: snapshot.openTrades,
  }
}

function positionDirection(position: Pick<PositionRow, "positionSide" | "amount">): "buy" | "sell" {
  if (position.positionSide === "SHORT") return "sell"
  if (position.positionSide === "LONG") return "buy"
  return position.amount < 0 ? "sell" : "buy"
}

/** Binance has no position ticket. A stable positive integer per symbol and side stands in. */
function positionTicket(position: Pick<PositionRow, "symbol" | "positionSide" | "amount">): number {
  const text = `${position.symbol}:${positionDirection(position)}`
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return hash + 1
}

function isCopierComment(value: unknown): boolean {
  return /^TS[Cc]opier/.test(String(value ?? ""))
}

export type BinanceTradeRow = {
  id: string
  broker_id: string
  broker_label: string
  broker_name: string | null
  ticket: number
  symbol: string
  direction: "buy" | "sell" | ""
  type: string
  lot_size: number
  entry_price: number | null
  sl: number | null
  tp: number | null
  close_price: number | null
  profit: number | null
  swap: number | null
  commission: number | null
  comment: string | null
  magic: number | null
  opened_at: string | null
  closed_at: string | null
  state: string | null
  status: "open" | "closed"
}

function iso(ms: number | undefined): string | null {
  if (!ms || ms <= 0) return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function binanceAccountTrades(args: {
  keys: BinanceKeys
  brokerId: string
  brokerLabel: string
  brokerName: string | null
  historyFrom: string
  historyTo: string
  scope: string
}): Promise<BinanceTradeRow[]> {
  const { keys } = args
  const scope = args.scope.toLowerCase()
  const rows: BinanceTradeRow[] = []

  if (scope !== "closed") {
    const positions = await binancePositions(keys)
    const entryComments = new Map<string, string>()
    for (const position of positions) {
      const side = positionDirection(position)
      try {
        const orders = asRows(await request<unknown>(keys, "GET", "/fapi/v1/allOrders", { symbol: position.symbol, limit: 100 }, true))
        const entry = orders
          .filter(order => isCopierComment(order.clientOrderId)
            && order.reduceOnly !== true
            && String(order.side ?? "").toUpperCase() === (side === "buy" ? "BUY" : "SELL")
            && ["FILLED", "PARTIALLY_FILLED"].includes(String(order.status ?? "")))
          .sort((a, b) => (finite(b.orderId) ?? 0) - (finite(a.orderId) ?? 0))[0]
        if (entry) entryComments.set(`${position.symbol}:${side}`, String(entry.clientOrderId))
      } catch {
        // The row still shows without a comment.
      }
      rows.push({
        id: `${args.brokerId}:${position.symbol}:${position.positionSide}`,
        broker_id: args.brokerId,
        broker_label: args.brokerLabel,
        broker_name: args.brokerName,
        ticket: positionTicket(position),
        symbol: position.symbol,
        direction: side,
        type: side === "sell" ? "Sell" : "Buy",
        lot_size: Math.abs(position.amount),
        entry_price: position.entryPrice || null,
        sl: null,
        tp: null,
        close_price: null,
        profit: position.unrealized,
        swap: null,
        commission: null,
        comment: entryComments.get(`${position.symbol}:${side}`) ?? null,
        magic: null,
        opened_at: iso(position.updateTime),
        closed_at: null,
        state: null,
        status: "open",
      })
    }
  }

  if (scope !== "open") {
    const to = Number.isFinite(Date.parse(args.historyTo)) ? Date.parse(args.historyTo) : Date.now()
    const from = Number.isFinite(Date.parse(args.historyFrom)) ? Date.parse(args.historyFrom) : to - SEVEN_DAYS_MS
    const windows: Array<[number, number]> = []
    for (let end = to, i = 0; end > from && i < 5; i += 1) {
      const start = Math.max(from, end - SEVEN_DAYS_MS + 1)
      windows.push([start, end])
      end = start - 1
    }

    const symbols = new Set<string>()
    for (const [start, end] of windows) {
      const income = asRows(await request<unknown>(keys, "GET", "/fapi/v1/income", {
        incomeType: "REALIZED_PNL",
        startTime: start,
        endTime: end,
        limit: 1000,
      }, true))
      for (const row of income) {
        const symbol = String(row.symbol ?? "")
        if (symbol) symbols.add(symbol)
      }
    }

    for (const symbol of [...symbols].slice(0, 12)) {
      const orders = new Map<number, Record<string, unknown>>()
      const closes = new Map<number, { qty: number; notional: number; profit: number; commission: number; side: string; time: number }>()
      for (const [start, end] of windows) {
        for (const order of asRows(await request<unknown>(keys, "GET", "/fapi/v1/allOrders", { symbol, startTime: start, endTime: end, limit: 1000 }, true))) {
          const id = finite(order.orderId)
          if (id) orders.set(id, order)
        }
        for (const fill of asRows(await request<unknown>(keys, "GET", "/fapi/v1/userTrades", { symbol, startTime: start, endTime: end, limit: 1000 }, true))) {
          const realized = finite(fill.realizedPnl) ?? 0
          if (realized === 0) continue
          const orderId = finite(fill.orderId)
          if (!orderId) continue
          const qty = finite(fill.qty) ?? 0
          const price = finite(fill.price) ?? 0
          const current = closes.get(orderId) ?? { qty: 0, notional: 0, profit: 0, commission: 0, side: String(fill.side ?? ""), time: 0 }
          current.qty += qty
          current.notional += qty * price
          current.profit += realized
          current.commission += finite(fill.commission) ?? 0
          current.time = Math.max(current.time, finite(fill.time) ?? 0)
          closes.set(orderId, current)
        }
      }

      const entries = [...orders.values()]
        .filter(order => isCopierComment(order.clientOrderId) && order.reduceOnly !== true)
        .sort((a, b) => (finite(a.orderId) ?? 0) - (finite(b.orderId) ?? 0))

      for (const [orderId, close] of closes) {
        const closeOrder = orders.get(orderId)
        const clientId = String(closeOrder?.clientOrderId ?? "")
        const ticketText = clientId.startsWith("TSX:") ? Number(clientId.split(":")[1]) : NaN
        let entry: Record<string, unknown> | undefined = Number.isFinite(ticketText) ? orders.get(ticketText) : undefined
        if (!entry && Number.isFinite(ticketText)) {
          try {
            entry = await request<Record<string, unknown>>(keys, "GET", "/fapi/v1/order", { symbol, orderId: ticketText }, true)
          } catch {
            entry = undefined
          }
        }
        if (!entry) {
          // Closed by a stop. Use the latest copier entry on the opposite side before the close.
          entry = entries
            .filter(order => String(order.side ?? "").toUpperCase() !== close.side.toUpperCase()
              && (finite(order.time) ?? 0) <= close.time)
            .pop()
        }
        const positionSide = close.side.toUpperCase() === "BUY" ? "sell" : "buy"
        rows.push({
          id: `${args.brokerId}:deal:${orderId}`,
          broker_id: args.brokerId,
          broker_label: args.brokerLabel,
          broker_name: args.brokerName,
          ticket: finite(entry?.orderId) ?? orderId,
          symbol,
          direction: positionSide,
          type: positionSide === "sell" ? "Sell" : "Buy",
          lot_size: close.qty,
          entry_price: finite(entry?.avgPrice) || null,
          sl: null,
          tp: null,
          close_price: close.qty > 0 ? close.notional / close.qty : null,
          profit: Math.round(close.profit * 1e8) / 1e8,
          swap: null,
          commission: -close.commission,
          comment: entry && isCopierComment(entry.clientOrderId) ? String(entry.clientOrderId) : (clientId || null),
          magic: null,
          opened_at: iso(finite(entry?.time)),
          closed_at: iso(close.time),
          state: null,
          status: "closed",
        })
      }
    }
  }

  return rows
}
