// cTrader Open API helpers for the ctrader-broker edge function.
// Payload numbers match worker/src/ctrader/protocol.ts.

const APPLICATION_AUTH_REQ = 2100
const APPLICATION_AUTH_RES = 2101
const ACCOUNT_AUTH_REQ = 2102
const ACCOUNT_AUTH_RES = 2103
const SYMBOLS_LIST_REQ = 2114
const SYMBOLS_LIST_RES = 2115
const SYMBOL_BY_ID_REQ = 2116
const SYMBOL_BY_ID_RES = 2117
const SUBSCRIBE_SPOTS_REQ = 2127
const SUBSCRIBE_SPOTS_RES = 2128
const SPOT_EVENT = 2131
const DEAL_LIST_REQ = 2133
const DEAL_LIST_RES = 2134
const SPOT_PRICE_SCALE = 100_000
const TRADER_REQ = 2121
const TRADER_RES = 2122
const RECONCILE_REQ = 2124
const RECONCILE_RES = 2125
const ERROR_RES = 2142
const ORDER_ERROR_EVENT = 2132
const ACCOUNTS_REQ = 2149
const ACCOUNTS_RES = 2150

export const CTRADER_NOT_CONFIGURED =
  "cTrader is not configured yet. Add the Open API app credentials, then try again."

export type CtraderEnvironment = "demo" | "live"

export interface CtraderApp {
  clientId: string
  clientSecret: string
}

export interface CtraderTradingAccount {
  accountId: string
  accountNumber: string | null
  brokerName: string | null
  live: boolean
  environment: CtraderEnvironment
}

export interface CtraderTokens {
  accessToken: string
  refreshToken: string
  expiresAt: string | null
}

type Waiter = {
  types: number[]
  resolve: (payload: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: number
}

type SpotListener = (payloadType: number, payload: Record<string, unknown>) => void

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord)
  if (value && typeof value === "object") return [value as Record<string, unknown>]
  return []
}

function finite(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function ctraderAppFromEnv(): CtraderApp | null {
  const clientId = String(Deno.env.get("CTRADER_CLIENT_ID") ?? "").trim()
  const clientSecret = String(Deno.env.get("CTRADER_CLIENT_SECRET") ?? "").trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export function ctraderAuthorizeUrl(args: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL("https://id.ctrader.com/my/settings/openapi/grantingaccess/")
  url.searchParams.set("client_id", args.clientId)
  url.searchParams.set("redirect_uri", args.redirectUri)
  url.searchParams.set("scope", "trading")
  url.searchParams.set("product", "web")
  url.searchParams.set("state", args.state)
  return url.toString()
}

export function allowedCtraderRedirect(uri: string): boolean {
  try {
    const url = new URL(uri)
    if (!url.pathname.endsWith("/brokers/ctrader/callback")) return false
    if (url.protocol === "https:") return true
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  } catch {
    return false
  }
}

export function readCtraderTokenResponse(body: unknown): {
  accessToken: string
  refreshToken: string
  expiresIn: number
} {
  const row = asRecord(body)
  const nested = asRecord(row.data ?? row.result)
  const accessToken = String(
    row.accessToken ?? row.access_token ?? nested.accessToken ?? nested.access_token ?? "",
  ).trim()
  const refreshToken = String(
    row.refreshToken ?? row.refresh_token ?? nested.refreshToken ?? nested.refresh_token ?? "",
  ).trim()
  const expiresIn = Number(row.expiresIn ?? row.expires_in ?? nested.expiresIn ?? nested.expires_in ?? 0)
  if (!accessToken) throw new Error("cTrader did not return an access token")
  return {
    accessToken,
    refreshToken,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0,
  }
}

export async function exchangeCtraderCode(args: {
  app: CtraderApp
  code: string
  redirectUri: string
}): Promise<CtraderTokens> {
  return requestCtraderToken({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.app.clientId,
    client_secret: args.app.clientSecret,
  })
}

export async function refreshCtraderToken(args: {
  app: CtraderApp
  refreshToken: string
}): Promise<CtraderTokens> {
  return requestCtraderToken({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.app.clientId,
    client_secret: args.app.clientSecret,
  })
}

async function requestCtraderToken(query: Record<string, string>): Promise<CtraderTokens> {
  const url = new URL("https://openapi.ctrader.com/apps/token")
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await fetch(url, { method: "GET" })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const row = asRecord(body)
    throw new Error(String(row.error_description ?? row.description ?? row.error ?? "cTrader token request failed"))
  }
  const token = readCtraderTokenResponse(body)
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresIn > 0 ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null,
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")
}

function base64UrlToString(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4)
  return atob(padded)
}

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  return bytesToBase64Url(new Uint8Array(signature))
}

export async function signCtraderState(userId: string, secret: string): Promise<string> {
  const exp = Date.now() + 10 * 60 * 1000
  const body = `${userId}.${exp}`
  const signature = await hmac(secret, body)
  return bytesToBase64Url(new TextEncoder().encode(`${body}.${signature}`))
}

export async function verifyCtraderState(state: string, userId: string, secret: string): Promise<boolean> {
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(base64UrlToString(state), char => char.charCodeAt(0)))
    const splitAt = decoded.lastIndexOf(".")
    if (splitAt <= 0) return false
    const body = decoded.slice(0, splitAt)
    const signature = decoded.slice(splitAt + 1)
    const expected = await hmac(secret, body)
    if (signature !== expected) return false
    const [owner, expRaw] = body.split(".")
    const exp = Number(expRaw)
    return owner === userId && Number.isFinite(exp) && exp > Date.now()
  } catch {
    return false
  }
}

class CtraderSocketSession {
  private readonly pending = new Map<string, Waiter>()
  private readonly listeners = new Set<SpotListener>()
  private seq = 0

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : ""
      if (raw) this.handle(raw)
    })
    socket.addEventListener("close", () => this.failAll(new Error("cTrader connection closed")))
  }

  listen(handler: SpotListener): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }

  request(payloadType: number, payload: Record<string, unknown>, responseTypes: number[]): Promise<Record<string, unknown>> {
    const clientMsgId = String(++this.seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId)
        reject(new Error("cTrader request timed out"))
      }, 20_000)
      this.pending.set(clientMsgId, { types: responseTypes, resolve, reject, timer })
      this.socket.send(JSON.stringify({ clientMsgId, payloadType, payload }))
    })
  }

  private handle(raw: string): void {
    let message: { clientMsgId?: string; payloadType?: number; payload?: Record<string, unknown> }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    const payloadType = Number(message.payloadType)
    const payload = asRecord(message.payload)
    const clientMsgId = String(message.clientMsgId ?? payload.clientMsgId ?? "")
    for (const listener of this.listeners) listener(payloadType, payload)
    const failure = payloadType === ERROR_RES || payloadType === ORDER_ERROR_EVENT
    const waiter = this.take(clientMsgId, failure ? null : payloadType)
    if (!waiter) return
    if (failure) {
      waiter.reject(new Error(String(payload.description ?? payload.errorCode ?? "cTrader rejected the request")))
      return
    }
    waiter.resolve(payload)
  }

  private take(clientMsgId: string, payloadType: number | null): Waiter | undefined {
    if (clientMsgId && this.pending.has(clientMsgId)) {
      const waiter = this.pending.get(clientMsgId)
      if (!waiter) return undefined
      if (payloadType != null && !waiter.types.includes(payloadType)) return undefined
      this.pending.delete(clientMsgId)
      clearTimeout(waiter.timer)
      return waiter
    }
    for (const [id, waiter] of this.pending) {
      if (payloadType == null || waiter.types.includes(payloadType)) {
        this.pending.delete(id)
        clearTimeout(waiter.timer)
        return waiter
      }
    }
    return undefined
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}

async function openSession(environment: CtraderEnvironment, app: CtraderApp): Promise<{ socket: WebSocket; session: CtraderSocketSession }> {
  const host = environment === "live" ? "live.ctraderapi.com" : "demo.ctraderapi.com"
  const socket = new WebSocket(`wss://${host}:5036`)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cTrader connection timed out")), 15_000)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("cTrader connection failed"))
    })
  })
  const session = new CtraderSocketSession(socket)
  await session.request(APPLICATION_AUTH_REQ, {
    clientId: app.clientId,
    clientSecret: app.clientSecret,
  }, [APPLICATION_AUTH_RES])
  return { socket, session }
}

export async function listCtraderAccounts(app: CtraderApp, accessToken: string): Promise<CtraderTradingAccount[]> {
  const { socket, session } = await openSession("demo", app)
  try {
    const payload = await session.request(ACCOUNTS_REQ, { accessToken }, [ACCOUNTS_RES])
    return asArray(payload.ctidTraderAccount).map(row => {
      const live = row.isLive === true
      const login = finite(row.traderLogin)
      return {
        accountId: String(row.ctidTraderAccountId ?? ""),
        accountNumber: login == null ? null : String(login),
        brokerName: row.brokerTitleShort == null ? null : String(row.brokerTitleShort),
        live,
        environment: live ? "live" : "demo",
      }
    }).filter(account => account.accountId)
  } finally {
    socket.close()
  }
}

export async function ctraderTrader(args: {
  app: CtraderApp
  environment: CtraderEnvironment
  accountId: string
  accessToken: string
}): Promise<Record<string, unknown>> {
  const { socket, session } = await openSession(args.environment, args.app)
  try {
    await session.request(ACCOUNT_AUTH_REQ, {
      ctidTraderAccountId: Number(args.accountId),
      accessToken: args.accessToken,
    }, [ACCOUNT_AUTH_RES])
    const payload = await session.request(TRADER_REQ, {
      ctidTraderAccountId: Number(args.accountId),
    }, [TRADER_RES])
    return asRecord(payload.trader)
  } finally {
    socket.close()
  }
}

function operationName(tradeSide: unknown): string {
  return Number(tradeSide) === 2 ? "Sell" : "Buy"
}

export async function ctraderOpenedOrders(args: {
  app: CtraderApp
  environment: CtraderEnvironment
  accountId: string
  accessToken: string
}): Promise<Record<string, unknown>[]> {
  const { socket, session } = await openSession(args.environment, args.app)
  try {
    const accountId = Number(args.accountId)
    await session.request(ACCOUNT_AUTH_REQ, {
      ctidTraderAccountId: accountId,
      accessToken: args.accessToken,
    }, [ACCOUNT_AUTH_RES])
    const names = await loadSymbolIndex(session, accountId)
    const snapshot = await session.request(RECONCILE_REQ, { ctidTraderAccountId: accountId }, [RECONCILE_RES])
    const rows: Record<string, unknown>[] = []
    for (const position of asArray(snapshot.position)) {
      const trade = asRecord(position.tradeData)
      const symbol = names.get(finite(trade.symbolId) ?? -1)
      const lotSize = symbol?.lotSize || 0
      const volume = finite(trade.volume) ?? 0
      const price = finite(position.price)
      rows.push({
        ticket: finite(position.positionId) ?? 0,
        positionTicket: finite(position.positionId) ?? 0,
        symbol: symbol?.name ?? "",
        operation: operationName(trade.tradeSide),
        lots: lotSize > 0 ? volume / lotSize : 0,
        openPrice: price != null && price > 0 ? price : undefined,
        profit: floatingProfit(position, undefined),
        comment: trade.comment == null ? "" : String(trade.comment),
      })
    }
    return rows
  } finally {
    socket.close()
  }
}

export async function ctraderQuote(args: {
  app: CtraderApp
  environment: CtraderEnvironment
  accountId: string
  accessToken: string
  symbol: string
}): Promise<{ symbol: string; bid: number; ask: number }> {
  const { socket, session } = await openSession(args.environment, args.app)
  try {
    const accountId = Number(args.accountId)
    await session.request(ACCOUNT_AUTH_REQ, {
      ctidTraderAccountId: accountId,
      accessToken: args.accessToken,
    }, [ACCOUNT_AUTH_RES])
    const symbols = await session.request(SYMBOLS_LIST_REQ, { ctidTraderAccountId: accountId }, [SYMBOLS_LIST_RES])
    const wanted = args.symbol.trim().toUpperCase()
    const match = asArray(symbols.symbol).find(row => String(row.symbolName ?? "").toUpperCase() === wanted)
    const symbolId = finite(match?.symbolId)
    if (symbolId == null) throw new Error(`Symbol ${args.symbol} is not on this cTrader account`)
    const spots = await collectSpots(session, accountId, [symbolId])
    const spot = spots.get(symbolId)
    if (!spot) throw new Error("cTrader quote is missing prices")
    return {
      symbol: String(match?.symbolName ?? args.symbol),
      bid: spot.bid,
      ask: spot.ask,
    }
  } finally {
    socket.close()
  }
}

export function ctraderStatusFromTrader(trader: Record<string, unknown>, environment: CtraderEnvironment): {
  healthy: boolean
  tradeAllowed: boolean
  balance: number | undefined
  equity: number | undefined
  profit: number | undefined
  currency: string | undefined
  login: number | undefined
  status: Record<string, unknown>
} {
  const access = finite(trader.accessRights)
  const tradeAllowed = access == null || access === 0
  const moneyDigits = finite(trader.moneyDigits) ?? 2
  const balance = moneyAmount(trader.balance, moneyDigits)
  const unrealized = moneyAmount(
    trader.unrealizedGrossProfit ?? trader.unrealizedNetProfit ?? trader.unrealizedProfit,
    moneyDigits,
  )
  const reportedEquity = moneyAmount(trader.equity, moneyDigits)
  const equity = reportedEquity ?? (
    balance != null && unrealized != null ? balance + unrealized : balance
  )
  const currency = trader.depositCurrency == null ? undefined : String(trader.depositCurrency)
  const login = finite(trader.traderLogin)
  return {
    healthy: tradeAllowed,
    tradeAllowed,
    balance,
    equity,
    profit: unrealized ?? (balance != null && equity != null ? equity - balance : undefined),
    currency,
    login,
    status: {
      status: "ready",
      terminal: { alive: true },
      broker: { connected: true, server: environment === "live" ? "cTrader Live" : "cTrader Demo" },
      account: {
        loggedIn: true,
        tradeAllowed,
        login,
        currency,
        type: environment === "live" ? "Live" : "Demo",
      },
      bridge: { tradeEaReady: true, symbolsSynced: true },
    },
  }
}

type SymbolInfo = { name: string; digits: number; lotSize: number }

function moneyAmount(value: unknown, moneyDigits: number): number | undefined {
  const amount = finite(value)
  if (amount == null) return undefined
  const digits = Number.isFinite(moneyDigits) && moneyDigits >= 0 ? moneyDigits : 2
  return amount / 10 ** digits
}

function lotsFromVolume(volume: number, lotSize: number): number {
  if (!Number.isFinite(volume) || !Number.isFinite(lotSize) || lotSize <= 0) return 0
  return volume / lotSize
}

function absolutePrice(value: unknown): number | null {
  const price = finite(value)
  if (price == null || price <= 0) return null
  return price
}

function floatingProfit(
  position: Record<string, unknown>,
  spot: { bid: number; ask: number } | undefined,
): number | null {
  if (!spot) return null
  const trade = asRecord(position.tradeData)
  const entry = absolutePrice(position.price)
  const volume = finite(trade.volume)
  if (entry == null || volume == null || volume <= 0) return null
  const sell = Number(trade.tradeSide) === 2
  const mark = sell ? spot.ask : spot.bid
  const units = volume / 100
  const profit = (mark - entry) * units * (sell ? -1 : 1)
  return Number.isFinite(profit) ? Math.round(profit * 100) / 100 : null
}

async function loadSymbolIndex(
  session: CtraderSocketSession,
  accountId: number,
): Promise<Map<number, SymbolInfo>> {
  const symbols = await session.request(SYMBOLS_LIST_REQ, { ctidTraderAccountId: accountId }, [SYMBOLS_LIST_RES])
  const names = new Map<number, SymbolInfo>()
  const missing: number[] = []
  for (const row of asArray(symbols.symbol)) {
    const symbolId = finite(row.symbolId)
    if (symbolId == null) continue
    const lotSize = finite(row.lotSize) ?? 0
    names.set(symbolId, {
      name: String(row.symbolName ?? ""),
      digits: finite(row.digits) ?? 5,
      lotSize,
    })
    if (!lotSize) missing.push(symbolId)
  }
  if (missing.length) {
    const detail = await session.request(SYMBOL_BY_ID_REQ, {
      ctidTraderAccountId: accountId,
      symbolId: missing,
    }, [SYMBOL_BY_ID_RES])
    for (const row of asArray(detail.symbol)) {
      const symbolId = finite(row.symbolId)
      if (symbolId == null) continue
      const current = names.get(symbolId)
      names.set(symbolId, {
        name: current?.name || String(row.symbolName ?? ""),
        digits: finite(row.digits) ?? current?.digits ?? 5,
        lotSize: finite(row.lotSize) ?? current?.lotSize ?? 0,
      })
    }
  }
  return names
}

async function collectSpots(
  session: CtraderSocketSession,
  accountId: number,
  symbolIds: number[],
): Promise<Map<number, { bid: number; ask: number }>> {
  const spots = new Map<number, { bid: number; ask: number }>()
  if (!symbolIds.length) return spots
  const wanted = new Set(symbolIds)
  const stop = session.listen((payloadType, payload) => {
    if (payloadType !== SPOT_EVENT) return
    const symbolId = finite(payload.symbolId)
    const bid = finite(payload.bid)
    const ask = finite(payload.ask)
    if (symbolId == null || !wanted.has(symbolId) || bid == null || ask == null) return
    spots.set(symbolId, { bid: bid / SPOT_PRICE_SCALE, ask: ask / SPOT_PRICE_SCALE })
  })
  try {
    await session.request(SUBSCRIBE_SPOTS_REQ, {
      ctidTraderAccountId: accountId,
      symbolId: symbolIds,
    }, [SUBSCRIBE_SPOTS_RES, SPOT_EVENT])
    const deadline = Date.now() + 2500
    while (spots.size < wanted.size && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } finally {
    stop()
  }
  return spots
}

export type CtraderTradeRow = {
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

function isoTime(value: unknown): string | null {
  const stamp = finite(value)
  if (stamp == null || stamp <= 0) return null
  const ms = stamp < 10_000_000_000 ? stamp * 1000 : stamp
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export async function ctraderAccountTrades(args: {
  app: CtraderApp
  environment: CtraderEnvironment
  accountId: string
  accessToken: string
  brokerId: string
  brokerLabel: string
  brokerName: string | null
  historyFrom: string
  historyTo: string
  scope: string
}): Promise<CtraderTradeRow[]> {
  const { socket, session } = await openSession(args.environment, args.app)
  try {
    const accountId = Number(args.accountId)
    await session.request(ACCOUNT_AUTH_REQ, {
      ctidTraderAccountId: accountId,
      accessToken: args.accessToken,
    }, [ACCOUNT_AUTH_RES])
    const names = await loadSymbolIndex(session, accountId)
    const rows: CtraderTradeRow[] = []
    const scope = args.scope.toLowerCase()

    if (scope !== "closed") {
      const snapshot = await session.request(RECONCILE_REQ, { ctidTraderAccountId: accountId }, [RECONCILE_RES])
      const positions = asArray(snapshot.position)
      const symbolIds = [...new Set(positions.map(position => finite(asRecord(position.tradeData).symbolId)).filter((id): id is number => id != null))]
      const spots = await collectSpots(session, accountId, symbolIds)
      for (const position of positions) {
        const trade = asRecord(position.tradeData)
        const symbol = names.get(finite(trade.symbolId) ?? -1)
        const ticket = finite(position.positionId) ?? 0
        if (!ticket) continue
        const side = Number(trade.tradeSide) === 2 ? "sell" : "buy"
        const volume = finite(trade.volume) ?? 0
        rows.push({
          id: `${args.brokerId}:${ticket}`,
          broker_id: args.brokerId,
          broker_label: args.brokerLabel,
          broker_name: args.brokerName,
          ticket,
          symbol: symbol?.name ?? "",
          direction: side,
          type: side === "sell" ? "Sell" : "Buy",
          lot_size: lotsFromVolume(volume, symbol?.lotSize ?? 0),
          entry_price: absolutePrice(position.price),
          sl: absolutePrice(position.stopLoss),
          tp: absolutePrice(position.takeProfit),
          close_price: null,
          profit: floatingProfit(position, spots.get(finite(trade.symbolId) ?? -1)),
          swap: moneyAmount(position.swap, 2),
          commission: moneyAmount(position.commission, 2),
          comment: trade.comment == null ? null : String(trade.comment),
          magic: null,
          opened_at: isoTime(trade.openTimestamp ?? position.utcLastUpdateTimestamp),
          closed_at: null,
          state: null,
          status: "open",
        })
      }
    }

    if (scope !== "open") {
      const from = Date.parse(args.historyFrom)
      const to = Date.parse(args.historyTo)
      const deals = await session.request(DEAL_LIST_REQ, {
        ctidTraderAccountId: accountId,
        fromTimestamp: Number.isFinite(from) ? from : Date.now() - 90 * 24 * 60 * 60 * 1000,
        toTimestamp: Number.isFinite(to) ? to : Date.now(),
      }, [DEAL_LIST_RES])
      const commentsByPosition = new Map<number, string>()
      for (const deal of asArray(deals.deal)) {
        const positionId = finite(deal.positionId)
        const comment = deal.comment == null ? "" : String(deal.comment).trim()
        if (positionId != null && comment && !commentsByPosition.has(positionId)) {
          commentsByPosition.set(positionId, comment)
        }
      }
      for (const deal of asArray(deals.deal)) {
        const close = asRecord(deal.closePositionDetail)
        if (!Object.keys(close).length) continue
        const symbol = names.get(finite(deal.symbolId) ?? -1)
        const ticket = finite(deal.positionId ?? deal.dealId) ?? 0
        if (!ticket) continue
        const side = Number(deal.tradeSide) === 2 ? "sell" : "buy"
        const volume = finite(close.closedVolume ?? deal.filledVolume ?? deal.volume) ?? 0
        const positionId = finite(deal.positionId)
        const comment = String(deal.comment ?? (positionId == null ? "" : commentsByPosition.get(positionId) ?? "")).trim()
        rows.push({
          id: `${args.brokerId}:deal:${finite(deal.dealId) ?? ticket}`,
          broker_id: args.brokerId,
          broker_label: args.brokerLabel,
          broker_name: args.brokerName,
          ticket,
          symbol: symbol?.name ?? "",
          direction: side,
          type: side === "sell" ? "Sell" : "Buy",
          lot_size: lotsFromVolume(volume, symbol?.lotSize ?? 0),
          entry_price: absolutePrice(close.entryPrice),
          sl: null,
          tp: null,
          close_price: absolutePrice(deal.executionPrice),
          profit: moneyAmount(close.grossProfit ?? close.profit, 2),
          swap: moneyAmount(close.swap, 2),
          commission: moneyAmount(close.commission, 2),
          comment: comment || null,
          magic: null,
          opened_at: isoTime(close.offsetTimestamp ?? close.entryTimestamp),
          closed_at: isoTime(deal.executionTimestamp ?? deal.createTimestamp),
          state: null,
          status: "closed",
        })
      }
    }

    return rows
  } finally {
    socket.close()
  }
}
