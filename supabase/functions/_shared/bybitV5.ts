/**
 * Bybit V5 linear derivatives REST helpers for the edge function (read-only calls).
 * Signed requests send `X-BAPI-*` headers and an HMAC-SHA256 hex signature of
 * `timestamp + apiKey + recvWindow + queryString`. Every reply is HTTP 200 with a
 * `retCode`; zero means success.
 * https://bybit-exchange.github.io/docs/v5/guide
 *
 * Note: Bybit answers 403 to US and mainland China IP addresses. Pin this function
 * to a supported Supabase region when linking from those networks.
 */

export type BybitEnvironment = "demo" | "live"

export const BYBIT_HOSTS: Record<BybitEnvironment, string> = {
  live: "https://api.bybit.com",
  demo: "https://api-demo.bybit.com",
}

export interface BybitKeys {
  apiKey: string
  apiSecret: string
  environment: BybitEnvironment
}

export class BybitError extends Error {
  constructor(message: string, readonly code: number | null, readonly status: number) {
    super(message)
  }
}

type Params = Record<string, string | number | boolean | null | undefined>

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const SETTLE_COINS = ["USDT", "USDC"] as const
const RECV_WINDOW = 10_000

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

export function bybitEnvironmentOf(value: unknown): BybitEnvironment {
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

/** `timestamp + apiKey + recvWindow + payload`, signed with the secret. */
export function bybitSignPayload(
  secret: string,
  timestamp: string | number,
  apiKey: string,
  recvWindow: string | number,
  payload: string,
): Promise<string> {
  return hmacHex(secret, `${timestamp}${apiKey}${recvWindow}${payload}`)
}

export async function bybitFingerprint(apiKey: string): Promise<string> {
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

export function friendlyBybitError(error: unknown): string {
  if (error instanceof BybitError) {
    if (error.status === 403) {
      return "Bybit blocked this request (HTTP 403). Bybit does not serve US or mainland China IP addresses, so the server region must be changed."
    }
    if (error.code === 10003 || error.code === 10004) {
      return "Bybit rejected this API key. Check the key and secret and that they belong to the selected environment (live or demo)."
    }
    if (error.code === 10005) {
      return "This Bybit API key lacks permission. Enable Contract Trade (Orders and Positions) and Unified Trading read access."
    }
    if (error.code === 10010) {
      return "Bybit rejected this server's IP address. Add it to the API key's IP whitelist or remove the restriction."
    }
    if (error.code === 10002) return "Bybit rejected the request timestamp. The server clock may be out of sync."
    return error.message
  }
  return error instanceof Error ? error.message : "Bybit request failed"
}

async function request<T>(keys: BybitKeys, path: string, params: Params, signed: boolean): Promise<T> {
  const qs = query(params)
  const headers: Record<string, string> = {}
  if (signed) {
    const timestamp = String(Date.now())
    headers["X-BAPI-API-KEY"] = keys.apiKey
    headers["X-BAPI-TIMESTAMP"] = timestamp
    headers["X-BAPI-RECV-WINDOW"] = String(RECV_WINDOW)
    headers["X-BAPI-SIGN"] = await bybitSignPayload(keys.apiSecret, timestamp, keys.apiKey, RECV_WINDOW, qs)
  }
  const response = await fetch(`${BYBIT_HOSTS[keys.environment]}${path}${qs ? `?${qs}` : ""}`, { method: "GET", headers })
  const text = await response.text()
  let body: Record<string, unknown> | null = null
  try {
    const parsed = text ? JSON.parse(text) : null
    body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
  } catch {
    body = null
  }
  if (!response.ok) throw new BybitError(`Bybit HTTP ${response.status}`, null, response.status)
  if (!body) throw new BybitError("Bybit returned an unreadable response", null, response.status)
  const code = finite(body.retCode)
  if (code !== 0) {
    const message = typeof body.retMsg === "string" && body.retMsg ? body.retMsg : "Bybit request failed"
    throw new BybitError(message, code ?? null, response.status)
  }
  return (body.result ?? {}) as T
}

/** Page through a cursor list. */
async function listAll(keys: BybitKeys, path: string, params: Params, maxPages = 10): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const result = await request<Record<string, unknown>>(keys, path, { ...params, cursor }, true)
    rows.push(...asRows(result.list))
    const next = typeof result.nextPageCursor === "string" ? result.nextPageCursor : ""
    if (!next) break
    cursor = next
  }
  return rows
}

export interface BybitSnapshot {
  balance: number | undefined
  equity: number | undefined
  profit: number | undefined
  available: number | undefined
  currency: string
  canTrade: boolean
  openTrades: number
  marginMode: string
  status: Record<string, unknown>
}

/** Unified Trading Accounts report `unifiedMarginStatus` 3 to 6. Classic accounts report 1. */
export function isUnifiedAccount(unifiedMarginStatus: unknown): boolean {
  const status = finite(unifiedMarginStatus)
  return status != null && status >= 3
}

async function canTradeContracts(keys: BybitKeys): Promise<boolean> {
  try {
    const info = await request<Record<string, unknown>>(keys, "/v5/user/query-api", {}, true)
    if (finite(info.readOnly) === 1) return false
    const permissions = info.permissions && typeof info.permissions === "object"
      ? info.permissions as Record<string, unknown>
      : {}
    const contract = Array.isArray(permissions.ContractTrade) ? permissions.ContractTrade.map(String) : null
    return contract == null ? true : contract.includes("Order")
  } catch {
    // Permission lookup is best effort. Trading errors surface on the first order.
    return true
  }
}

export async function bybitAccount(keys: BybitKeys): Promise<BybitSnapshot> {
  const info = await request<Record<string, unknown>>(keys, "/v5/account/info", {}, true)
  if (!isUnifiedAccount(info.unifiedMarginStatus)) {
    throw new BybitError(
      "This Bybit account is not a Unified Trading Account. Upgrade it to Unified in Bybit, then link again.",
      null,
      200,
    )
  }
  const wallet = await request<Record<string, unknown>>(keys, "/v5/account/wallet-balance", { accountType: "UNIFIED" }, true)
  const row = asRows(wallet.list)[0] ?? {}
  const positions = await bybitPositions(keys)
  const canTrade = await canTradeContracts(keys)
  const marginMode = String(info.marginMode ?? "")
  return {
    balance: finite(row.totalWalletBalance),
    equity: finite(row.totalEquity),
    profit: finite(row.totalPerpUPL),
    available: finite(row.totalAvailableBalance),
    currency: "USDT",
    canTrade,
    openTrades: positions.length,
    marginMode,
    status: {
      status: "ready",
      terminal: { alive: true },
      broker: { connected: true, server: keys.environment === "live" ? "Bybit Futures" : "Bybit Futures Demo" },
      account: {
        loggedIn: true,
        tradeAllowed: canTrade,
        currency: "USDT",
        type: keys.environment === "live" ? "Live" : "Demo",
        marginMode,
      },
      bridge: { tradeEaReady: true, symbolsSynced: true },
    },
  }
}

export async function bybitQuote(keys: BybitKeys, symbol: string): Promise<{ symbol: string; bid: number; ask: number }> {
  const wanted = symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
  const candidates = [wanted, wanted.endsWith("USD") ? `${wanted}T` : `${wanted}USDT`]
  for (const candidate of candidates) {
    try {
      const result = await request<Record<string, unknown>>(keys, "/v5/market/tickers", { category: "linear", symbol: candidate }, false)
      const row = asRows(result.list)[0]
      const bid = finite(row?.bid1Price)
      const ask = finite(row?.ask1Price)
      if (bid && ask) return { symbol: candidate, bid, ask }
    } catch {
      // Try the next spelling.
    }
  }
  throw new Error(`Symbol ${symbol} is not available on Bybit linear futures`)
}

type PositionRow = {
  symbol: string
  positionIdx: number
  side: "Buy" | "Sell"
  amount: number
  entryPrice: number
  markPrice: number
  unrealized: number
  leverage: number | undefined
  tradeMode: string
  liquidationPrice: number | undefined
  stopLoss: number | undefined
  takeProfit: number | undefined
  updateTime: number | undefined
}

export async function bybitPositions(keys: BybitKeys): Promise<PositionRow[]> {
  const rows: PositionRow[] = []
  for (const settleCoin of SETTLE_COINS) {
    const list = await listAll(keys, "/v5/position/list", { category: "linear", settleCoin, limit: 200 })
    for (const row of list) {
      const amount = finite(row.size) ?? 0
      const side = String(row.side ?? "")
      const symbol = String(row.symbol ?? "")
      if (!symbol || amount <= 0 || (side !== "Buy" && side !== "Sell")) continue
      const liq = finite(row.liqPrice)
      rows.push({
        symbol,
        positionIdx: finite(row.positionIdx) ?? 0,
        side,
        amount,
        entryPrice: finite(row.avgPrice) ?? 0,
        markPrice: finite(row.markPrice) ?? 0,
        unrealized: finite(row.unrealisedPnl) ?? 0,
        leverage: finite(row.leverage),
        tradeMode: finite(row.tradeMode) === 1 ? "isolated" : "cross",
        liquidationPrice: liq && liq > 0 ? liq : undefined,
        stopLoss: (() => {
          const v = finite(row.stopLoss)
          return v && v > 0 ? v : undefined
        })(),
        takeProfit: (() => {
          const v = finite(row.takeProfit)
          return v && v > 0 ? v : undefined
        })(),
        updateTime: finite(row.updatedTime),
      })
    }
  }
  return rows
}

/** Open positions as the broker book rows the dashboard reads. */
export async function bybitOpenedOrders(keys: BybitKeys): Promise<Record<string, unknown>[]> {
  const positions = await bybitPositions(keys)
  return positions.map(position => ({
    ticket: positionTicket(position),
    symbol: position.symbol,
    operation: position.side,
    lots: position.amount,
    openPrice: position.entryPrice || undefined,
    profit: position.unrealized,
    liquidationPrice: position.liquidationPrice,
    leverage: position.leverage,
    marginType: position.tradeMode,
    comment: "",
  }))
}

export async function bybitLiveBook(keys: BybitKeys): Promise<{
  balance: number | undefined
  equity: number | undefined
  profit: number | undefined
  currency: string
  openTrades: number
}> {
  const wallet = await request<Record<string, unknown>>(keys, "/v5/account/wallet-balance", { accountType: "UNIFIED" }, true)
  const row = asRows(wallet.list)[0] ?? {}
  const positions = await bybitPositions(keys)
  return {
    balance: finite(row.totalWalletBalance),
    equity: finite(row.totalEquity),
    profit: finite(row.totalPerpUPL),
    currency: "USDT",
    openTrades: positions.length,
  }
}

/** Bybit has no numeric position id. A stable positive integer per symbol and side stands in. */
function positionTicket(position: Pick<PositionRow, "symbol" | "side" | "positionIdx">): number {
  return hashId(`${position.symbol}:${position.side}:${position.positionIdx}`)
}

/** Order ids are UUID-like strings. Map them onto a positive 32-bit integer. */
export function hashId(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash + 1
}

function isCopierLinkId(value: unknown): boolean {
  return /^TS[Cc]opier/.test(String(value ?? ""))
}

/**
 * Order link ids look like `TScopier_<signal tail>_<ticket in base 36>` with `:` stored as `_`
 * and `.` as `-`. Drop the ticket and restore the readable comment.
 */
function commentFromLinkId(value: unknown): string {
  return String(value ?? "")
    .replace(/_[0-9a-z]{6,10}$/, "")
    .replace(/_/g, ":")
    .replace(/-/g, ".")
}

function closeTicket(linkId: string): number | null {
  const match = /^TSX_(\d+)_/.exec(linkId)
  if (!match) return null
  const n = Number(match[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function entryTicket(linkId: string): number | null {
  if (!isCopierLinkId(linkId)) return null
  const match = /_([0-9a-z]{6,10})$/.exec(linkId)
  if (!match) return null
  const n = parseInt(match[1], 36)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export type BybitTradeRow = {
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

export async function bybitAccountTrades(args: {
  keys: BybitKeys
  brokerId: string
  brokerLabel: string
  brokerName: string | null
  historyFrom: string
  historyTo: string
  scope: string
}): Promise<BybitTradeRow[]> {
  const { keys } = args
  const scope = args.scope.toLowerCase()
  const rows: BybitTradeRow[] = []

  if (scope !== "closed") {
    const positions = await bybitPositions(keys)
    for (const position of positions) {
      let comment: string | null = null
      try {
        const orders = asRows((await request<Record<string, unknown>>(keys, "/v5/order/history", {
          category: "linear",
          symbol: position.symbol,
          orderFilter: "Order",
          limit: 50,
        }, true)).list)
        const entry = orders
          .filter(order => isCopierLinkId(order.orderLinkId)
            && order.reduceOnly !== true
            && String(order.side ?? "") === position.side
            && ["Filled", "PartiallyFilledCanceled"].includes(String(order.orderStatus ?? "")))
          .sort((a, b) => (finite(b.createdTime) ?? 0) - (finite(a.createdTime) ?? 0))[0]
        if (entry) comment = commentFromLinkId(entry.orderLinkId)
      } catch {
        // The row still shows without a comment.
      }
      const direction = position.side === "Sell" ? "sell" : "buy"
      rows.push({
        id: `${args.brokerId}:${position.symbol}:${position.positionIdx}`,
        broker_id: args.brokerId,
        broker_label: args.brokerLabel,
        broker_name: args.brokerName,
        ticket: positionTicket(position),
        symbol: position.symbol,
        direction,
        type: position.side,
        lot_size: position.amount,
        entry_price: position.entryPrice || null,
        sl: position.stopLoss ?? null,
        tp: position.takeProfit ?? null,
        close_price: null,
        profit: position.unrealized,
        swap: null,
        commission: null,
        comment,
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

    const closed: Record<string, unknown>[] = []
    for (const [start, end] of windows) {
      closed.push(...await listAll(keys, "/v5/position/closed-pnl", {
        category: "linear",
        startTime: start,
        endTime: end,
        limit: 100,
      }, 5))
    }

    const symbols = [...new Set(closed.map(row => String(row.symbol ?? "")).filter(Boolean))].slice(0, 12)
    const linkIds = new Map<string, string>()
    const entryByTicket = new Map<number, string>()
    for (const symbol of symbols) {
      for (const [start, end] of windows) {
        try {
          const orders = await listAll(keys, "/v5/order/history", {
            category: "linear",
            symbol,
            orderFilter: "Order",
            startTime: start,
            endTime: end,
            limit: 50,
          }, 5)
          for (const order of orders) {
            const orderId = String(order.orderId ?? "")
            const linkId = String(order.orderLinkId ?? "")
            if (orderId && linkId) linkIds.set(orderId, linkId)
            const ticket = entryTicket(linkId)
            if (ticket) entryByTicket.set(ticket, linkId)
          }
        } catch {
          // Closed rows still show without comments.
        }
      }
    }

    for (const row of closed) {
      const orderId = String(row.orderId ?? "")
      const symbol = String(row.symbol ?? "")
      if (!orderId || !symbol) continue
      const linkId = linkIds.get(orderId) ?? ""
      const ticket = closeTicket(linkId) ?? hashId(orderId)
      const closingSell = String(row.side ?? "") === "Sell"
      const entryLink = entryByTicket.get(ticket)
      const fees = (finite(row.openFee) ?? 0) + (finite(row.closeFee) ?? 0)
      const closedAt = finite(row.updatedTime) ?? finite(row.createdTime)
      rows.push({
        id: `${args.brokerId}:pnl:${orderId}`,
        broker_id: args.brokerId,
        broker_label: args.brokerLabel,
        broker_name: args.brokerName,
        ticket,
        symbol,
        direction: closingSell ? "buy" : "sell",
        type: closingSell ? "Buy" : "Sell",
        lot_size: finite(row.closedSize) ?? finite(row.qty) ?? 0,
        entry_price: finite(row.avgEntryPrice) || null,
        sl: null,
        tp: null,
        close_price: finite(row.avgExitPrice) || null,
        profit: finite(row.closedPnl) ?? null,
        swap: null,
        commission: -fees,
        comment: entryLink ? commentFromLinkId(entryLink) : (linkId ? commentFromLinkId(linkId) : null),
        magic: null,
        opened_at: null,
        closed_at: iso(closedAt),
        state: null,
        status: "closed",
      })
    }
  }

  return rows
}
