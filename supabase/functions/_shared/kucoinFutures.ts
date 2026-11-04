/**
 * KuCoin Futures (classic account) REST helpers for the edge function (read-only calls).
 * Private requests send `KC-API-*` headers:
 *   sign       = base64(HMAC-SHA256(secret, timestamp + METHOD + path[?query] + body))
 *   passphrase = base64(HMAC-SHA256(secret, passphrase))
 * Replies are `{ code, data }`; code "200000" is success.
 * https://www.kucoin.com/docs-new/authentication
 */

export const KUCOIN_FUTURES_HOST = "https://api-futures.kucoin.com"
/** Account-level calls (API key info) live on the spot host. */
export const KUCOIN_MAIN_HOST = "https://api.kucoin.com"

export interface KucoinKeys {
  apiKey: string
  apiSecret: string
  passphrase: string
}

export class KucoinError extends Error {
  constructor(message: string, readonly code: number | null, readonly status: number) {
    super(message)
  }
}

type Params = Record<string, string | number | boolean | null | undefined>

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const PAGE_SIZE = 200
const KEY_VERSIONS = ["3", "2"] as const

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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function hmacBase64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))
  let binary = ""
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** `timestamp + METHOD + requestPath + body`, signed as base64. */
export function kucoinSignRequest(
  secret: string,
  timestamp: string | number,
  method: string,
  requestPath: string,
  body: string,
): Promise<string> {
  return hmacBase64(secret, `${timestamp}${method.toUpperCase()}${requestPath}${body}`)
}

export function kucoinSignPassphrase(secret: string, passphrase: string): Promise<string> {
  return hmacBase64(secret, passphrase)
}

export async function kucoinFingerprint(apiKey: string): Promise<string> {
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

export function friendlyKucoinError(error: unknown): string {
  if (error instanceof KucoinError) {
    if (error.code === 400003) return "KuCoin does not know this API key. Check the key."
    if (error.code === 400004) return "KuCoin rejected the API passphrase. Use the passphrase you set when you created the key."
    if (error.code === 400005) return "KuCoin rejected the request signature. Check the API secret."
    if (error.code === 400006) {
      return "KuCoin rejected this server's IP address. Add it to the API key's IP whitelist or remove the restriction."
    }
    if (error.code === 400007) return "This KuCoin API key lacks permission. Enable General and Futures permissions."
    if (error.code === 400002) return "KuCoin rejected the request timestamp. The server clock may be out of sync."
    if (error.code === 40010) {
      return "KuCoin restricts this account or server region from trading (40010)."
    }
    if (error.status === 403) return "KuCoin blocked this request (HTTP 403). Check the server region and the key's IP whitelist."
    return error.message
  }
  return error instanceof Error ? error.message : "KuCoin request failed"
}

/**
 * Key version 3 first, then 2. A wrong version fails as a passphrase or signature error before
 * anything is accepted, so trying the next one is safe.
 */
async function request<T>(keys: KucoinKeys, host: string, path: string, params: Params, signed: boolean): Promise<T> {
  const qs = query(params)
  const requestPath = qs ? `${path}?${qs}` : path
  const versions = signed ? KEY_VERSIONS : ["3"]
  let lastError: KucoinError | null = null
  for (const version of versions) {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (signed) {
      const timestamp = String(Date.now())
      headers["KC-API-KEY"] = keys.apiKey
      headers["KC-API-SIGN"] = await kucoinSignRequest(keys.apiSecret, timestamp, "GET", requestPath, "")
      headers["KC-API-TIMESTAMP"] = timestamp
      headers["KC-API-PASSPHRASE"] = await kucoinSignPassphrase(keys.apiSecret, keys.passphrase)
      headers["KC-API-KEY-VERSION"] = version
    }
    const response = await fetch(`${host}${requestPath}`, { method: "GET", headers })
    const text = await response.text()
    let body: Record<string, unknown> | null = null
    try {
      const parsed = text ? JSON.parse(text) : null
      body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
    } catch {
      body = null
    }
    if (!body) {
      throw new KucoinError(
        response.ok ? "KuCoin returned an unreadable response" : `KuCoin HTTP ${response.status}`,
        null,
        response.status,
      )
    }
    const code = finite(body.code)
    if (code === 200000) return body.data as T
    const message = typeof body.msg === "string" && body.msg ? body.msg : "KuCoin request failed"
    lastError = new KucoinError(message, code ?? null, response.status)
    if (!signed || (code !== 400004 && code !== 400005)) throw lastError
  }
  throw lastError ?? new KucoinError("KuCoin request failed", null, 0)
}

const futures = <T>(keys: KucoinKeys, path: string, params: Params = {}, signed = true) =>
  request<T>(keys, KUCOIN_FUTURES_HOST, path, params, signed)

async function paged(keys: KucoinKeys, path: string, params: Params, maxPages = 5): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  for (let page = 1; page <= maxPages; page += 1) {
    const result = record(await futures(keys, path, { ...params, currentPage: page, pageSize: PAGE_SIZE }))
    rows.push(...asRows(result.items))
    if (page >= (finite(result.totalPage) ?? 1)) break
  }
  return rows
}

// ── Contracts ───────────────────────────────────────────────────────────────

type Contract = { symbol: string; multiplier: number; settleCurrency: string; isInverse: boolean; status: string }

let contractCache: { at: number; byName: Map<string, Contract> } | null = null

async function contracts(): Promise<Map<string, Contract>> {
  if (contractCache && Date.now() - contractCache.at < 10 * 60_000) return contractCache.byName
  const empty: KucoinKeys = { apiKey: "", apiSecret: "", passphrase: "" }
  const rows = asRows(await futures(empty, "/api/v1/contracts/active", {}, false))
  const byName = new Map<string, Contract>()
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").toUpperCase()
    if (!symbol) continue
    byName.set(symbol, {
      symbol,
      multiplier: finite(row.multiplier) ?? 1,
      settleCurrency: String(row.settleCurrency ?? "").toUpperCase(),
      isInverse: row.isInverse === true,
      status: String(row.status ?? ""),
    })
  }
  contractCache = { at: Date.now(), byName }
  return byName
}

function tradable(contract: Contract | undefined): contract is Contract {
  return !!contract && !contract.isInverse && contract.status === "Open"
}

/** `BTCUSDT`, `BTC/USDT` and `BTCUSDT.P` become `XBTUSDTM`. Bare bases use the USDT contract. */
async function resolveSymbol(input: string): Promise<Contract | null> {
  const all = await contracts()
  const raw = input.trim().toUpperCase()
  const exact = all.get(raw)
  if (tradable(exact)) return exact
  const cleaned = raw.replace(/\.P$/, "").replace(/PERP$/, "").replace(/[^A-Z0-9]/g, "")
  const direct = all.get(cleaned)
  if (tradable(direct)) return direct
  let base = cleaned
  let settle = "USDT"
  if (cleaned.endsWith("USDT")) base = cleaned.slice(0, -4)
  else if (cleaned.endsWith("USDC")) {
    base = cleaned.slice(0, -4)
    settle = "USDC"
  } else if (cleaned.endsWith("USD")) base = cleaned.slice(0, -3)
  const bases = [...(base === "BTC" ? ["XBT"] : []), base, `1000${base}`]
  for (const candidateBase of bases) {
    for (const candidateSettle of settle === "USDT" ? ["USDT"] : [settle, "USDT"]) {
      const found = all.get(`${candidateBase}${candidateSettle}M`)
      if (tradable(found)) return found
    }
  }
  return null
}

// ── Account ─────────────────────────────────────────────────────────────────

export interface KucoinSnapshot {
  balance: number | undefined
  equity: number | undefined
  profit: number | undefined
  available: number | undefined
  currency: string
  canTrade: boolean
  openTrades: number
  status: Record<string, unknown>
}

/** Futures permission from the key's own metadata. Best effort: a lookup failure does not block linking. */
async function hasFuturesPermission(keys: KucoinKeys): Promise<boolean> {
  try {
    const info = record(await request(keys, KUCOIN_MAIN_HOST, "/api/v1/user/api-key", {}, true))
    const permission = String(info.permission ?? "")
    if (!permission) return true
    return permission.split(",").map(item => item.trim().toLowerCase()).includes("futures")
  } catch {
    return true
  }
}

export async function kucoinAccount(keys: KucoinKeys): Promise<KucoinSnapshot> {
  const overview = record(await futures(keys, "/api/v1/account-overview", { currency: "USDT" }))
  const positions = await kucoinPositions(keys)
  const canTrade = await hasFuturesPermission(keys)
  return {
    balance: finite(overview.marginBalance),
    equity: finite(overview.accountEquity),
    profit: finite(overview.unrealisedPNL),
    available: finite(overview.availableBalance),
    currency: "USDT",
    canTrade,
    openTrades: positions.length,
    status: {
      status: "ready",
      terminal: { alive: true },
      broker: { connected: true, server: "KuCoin Futures" },
      account: { loggedIn: true, tradeAllowed: canTrade, currency: "USDT", type: "Live" },
      bridge: { tradeEaReady: true, symbolsSynced: true },
    },
  }
}

export async function kucoinQuote(keys: KucoinKeys, symbol: string): Promise<{ symbol: string; bid: number; ask: number }> {
  const contract = await resolveSymbol(symbol)
  if (!contract) throw new Error(`Symbol ${symbol} is not available on KuCoin futures`)
  const row = record(await futures(keys, "/api/v1/ticker", { symbol: contract.symbol }, false))
  const bid = finite(row.bestBidPrice)
  const ask = finite(row.bestAskPrice)
  if (!bid || !ask) throw new Error(`KuCoin quote for ${contract.symbol} is unavailable`)
  return { symbol: contract.symbol, bid, ask }
}

type PositionRow = {
  id: string
  symbol: string
  side: "Buy" | "Sell"
  /** Base-asset units (lots x multiplier). */
  amount: number
  entryPrice: number
  markPrice: number
  unrealized: number
  leverage: number | undefined
  marginMode: string
  liquidationPrice: number | undefined
  openedAt: number | undefined
}

export async function kucoinPositions(keys: KucoinKeys): Promise<PositionRow[]> {
  const rows = asRows(await futures(keys, "/api/v1/positions"))
  const all = await contracts().catch(() => new Map<string, Contract>())
  const out: PositionRow[] = []
  for (const row of rows) {
    const symbol = String(row.symbol ?? "")
    const quantity = finite(row.currentQty) ?? 0
    if (!symbol || quantity === 0 || row.isOpen === false) continue
    const positionSide = String(row.positionSide ?? "BOTH")
    const side = positionSide === "LONG" ? "Buy" : positionSide === "SHORT" ? "Sell" : (quantity > 0 ? "Buy" : "Sell")
    const multiplier = all.get(symbol)?.multiplier ?? 1
    const liq = finite(row.liquidationPrice)
    out.push({
      id: String(row.id ?? symbol),
      symbol,
      side,
      amount: Number((Math.abs(quantity) * multiplier).toPrecision(12)),
      entryPrice: finite(row.avgEntryPrice) ?? 0,
      markPrice: finite(row.markPrice) ?? 0,
      unrealized: finite(row.unrealisedPnl) ?? 0,
      leverage: finite(row.leverage) ?? finite(row.realLeverage),
      marginMode: String(row.marginMode ?? "").toUpperCase() === "CROSS" || row.crossMode === true ? "cross" : "isolated",
      liquidationPrice: liq && liq > 0 ? liq : undefined,
      openedAt: finite(row.openingTimestamp),
    })
  }
  return out
}

/** Open positions as the broker book rows the dashboard reads. */
export async function kucoinOpenedOrders(keys: KucoinKeys): Promise<Record<string, unknown>[]> {
  const positions = await kucoinPositions(keys)
  return positions.map(position => ({
    ticket: positionTicket(position),
    symbol: position.symbol,
    operation: position.side,
    lots: position.amount,
    openPrice: position.entryPrice || undefined,
    profit: position.unrealized,
    liquidationPrice: position.liquidationPrice,
    leverage: position.leverage,
    marginType: position.marginMode,
    comment: "",
  }))
}

export async function kucoinLiveBook(keys: KucoinKeys): Promise<{
  balance: number | undefined
  equity: number | undefined
  profit: number | undefined
  currency: string
  openTrades: number
}> {
  const overview = record(await futures(keys, "/api/v1/account-overview", { currency: "USDT" }))
  const positions = await kucoinPositions(keys)
  return {
    balance: finite(overview.marginBalance),
    equity: finite(overview.accountEquity),
    profit: finite(overview.unrealisedPNL),
    currency: "USDT",
    openTrades: positions.length,
  }
}

// ── Trades ──────────────────────────────────────────────────────────────────

/** KuCoin positions have string ids. A stable positive integer per symbol and side stands in. */
function positionTicket(position: Pick<PositionRow, "symbol" | "side">): number {
  return hashId(`${position.symbol}:${position.side}`)
}

/** Order ids are strings. Map them onto a positive 32-bit integer. */
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
 * Client order ids look like `TScopier_<signal tail>_<ticket in base 36>` with `:` stored as
 * `_` and `.` as `-`. Drop the ticket and restore the readable comment.
 */
function commentFromLinkId(value: unknown): string {
  return String(value ?? "")
    .replace(/_[0-9a-z]{6,10}$/, "")
    .replace(/_/g, ":")
    .replace(/-/g, ".")
}

function closeTicket(clientOid: string | undefined): number | null {
  const match = /^TSX_(\d+)_/.exec(clientOid ?? "")
  if (!match) return null
  const n = Number(match[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** Fills report nanoseconds; most other fields report milliseconds. */
function epochMs(value: unknown): number | undefined {
  const n = finite(value)
  if (n == null || n <= 0) return undefined
  if (n > 1e17) return Math.round(n / 1e6)
  if (n > 1e14) return Math.round(n / 1e3)
  return n
}

export type KucoinTradeRow = {
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

export async function kucoinAccountTrades(args: {
  keys: KucoinKeys
  brokerId: string
  brokerLabel: string
  brokerName: string | null
  historyFrom: string
  historyTo: string
  scope: string
}): Promise<KucoinTradeRow[]> {
  const { keys } = args
  const scope = args.scope.toLowerCase()
  const rows: KucoinTradeRow[] = []

  if (scope !== "closed") {
    const positions = await kucoinPositions(keys)
    for (const position of positions) {
      let comment: string | null = null
      try {
        const now = Date.now()
        const orders = await paged(keys, "/api/v1/orders", {
          status: "done",
          symbol: position.symbol,
          startAt: now - SEVEN_DAYS_MS + 1,
          endAt: now,
        }, 2)
        const entry = orders
          .filter(order => isCopierLinkId(order.clientOid)
            && order.reduceOnly !== true
            && order.closeOrder !== true
            && String(order.side ?? "") === (position.side === "Buy" ? "buy" : "sell")
            && (finite(order.filledSize) ?? 0) > 0)
          .sort((a, b) => (finite(b.createdAt) ?? 0) - (finite(a.createdAt) ?? 0))[0]
        if (entry) comment = commentFromLinkId(entry.clientOid)
      } catch {
        // The row still shows without a comment.
      }
      rows.push({
        id: `${args.brokerId}:${position.symbol}:${position.side}`,
        broker_id: args.brokerId,
        broker_label: args.brokerLabel,
        broker_name: args.brokerName,
        ticket: positionTicket(position),
        symbol: position.symbol,
        direction: position.side === "Sell" ? "sell" : "buy",
        type: position.side,
        lot_size: position.amount,
        entry_price: position.entryPrice || null,
        sl: null,
        tp: null,
        close_price: null,
        profit: position.unrealized,
        swap: null,
        commission: null,
        comment,
        magic: null,
        opened_at: iso(position.openedAt),
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
      for (let page = 1; page <= 5; page += 1) {
        const result = record(await futures(keys, "/api/v1/history-positions", { from: start, to: end, limit: PAGE_SIZE, pageId: page }))
        closed.push(...asRows(result.items))
        if (page >= (finite(result.totalPage) ?? 1)) break
      }
    }

    if (closed.length > 0) {
      const fills: Record<string, unknown>[] = []
      for (const [start, end] of windows) {
        try {
          fills.push(...await paged(keys, "/api/v1/fills", { startAt: start - 60_000, endAt: end + 60_000 }))
        } catch {
          // Rows still show without a size.
        }
      }
      const symbols = [...new Set(closed.map(row => String(row.symbol ?? "")).filter(Boolean))].slice(0, 12)
      const links = new Map<string, string>()
      const entries: Array<{ symbol: string; side: string; at: number; clientOid: string }> = []
      for (const symbol of symbols) {
        for (const [start, end] of windows) {
          try {
            const orders = await paged(keys, "/api/v1/orders", {
              status: "done",
              symbol,
              startAt: start - 60_000,
              endAt: end + 60_000,
            })
            for (const order of orders) {
              const orderId = String(order.id ?? "")
              const clientOid = String(order.clientOid ?? "")
              if (orderId && clientOid) links.set(orderId, clientOid)
              if (isCopierLinkId(clientOid) && order.reduceOnly !== true && order.closeOrder !== true) {
                entries.push({ symbol, side: String(order.side ?? ""), at: finite(order.createdAt) ?? 0, clientOid })
              }
            }
          } catch {
            // Closed rows still show without comments.
          }
        }
      }
      const all = await contracts().catch(() => new Map<string, Contract>())

      for (const row of closed) {
        const symbol = String(row.symbol ?? "")
        const type = String(row.type ?? "")
        const longPosition = /LONG/.test(type)
        const openTime = finite(row.openTime) ?? 0
        const closeTime = finite(row.closeTime) ?? 0
        const closingSide = longPosition ? "sell" : "buy"
        const closingFills = fills.filter(fill => {
          if (String(fill.symbol ?? "") !== symbol || String(fill.side ?? "") !== closingSide) return false
          const at = epochMs(fill.tradeTime) ?? 0
          return at >= openTime - 1_000 && at <= closeTime + 1_000
        })
        const lots = closingFills.reduce((sum, fill) => sum + (finite(fill.size) ?? 0), 0)
        const multiplier = all.get(symbol)?.multiplier ?? 1
        const closeTicketFill = closingFills
          .map(fill => closeTicket(links.get(String(fill.orderId ?? ""))))
          .find(ticket => ticket != null)
        const entry = entries
          .filter(item => item.symbol === symbol
            && item.side === (longPosition ? "buy" : "sell")
            && item.at >= openTime - 60_000
            && item.at <= closeTime)
          .sort((a, b) => a.at - b.at)[0]
        const closeId = String(row.closeId ?? `${symbol}:${closeTime}`)
        rows.push({
          id: `${args.brokerId}:pos:${closeId}`,
          broker_id: args.brokerId,
          broker_label: args.brokerLabel,
          broker_name: args.brokerName,
          ticket: closeTicketFill ?? hashId(closeId),
          symbol,
          direction: longPosition ? "buy" : "sell",
          type: longPosition ? "Buy" : "Sell",
          lot_size: Number((lots * multiplier).toPrecision(12)),
          entry_price: finite(row.openPrice) || null,
          sl: null,
          tp: null,
          close_price: finite(row.closePrice) || null,
          profit: finite(row.pnl) ?? null,
          swap: -(finite(row.fundingFee) ?? 0),
          commission: -(finite(row.tradeFee) ?? 0),
          comment: entry ? commentFromLinkId(entry.clientOid) : null,
          magic: null,
          opened_at: iso(openTime),
          closed_at: iso(closeTime),
          state: null,
          status: "closed",
        })
      }
    }
  }

  return rows
}
