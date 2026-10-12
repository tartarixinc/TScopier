// cTrader Open API helpers for the ctrader-broker edge function.
// Payload numbers match worker/src/ctrader/protocol.ts.

const APPLICATION_AUTH_REQ = 2100
const APPLICATION_AUTH_RES = 2101
const ACCOUNT_AUTH_REQ = 2102
const ACCOUNT_AUTH_RES = 2103
const SYMBOLS_LIST_REQ = 2114
const SYMBOLS_LIST_RES = 2115
const SUBSCRIBE_SPOTS_REQ = 2127
const SPOT_EVENT = 2131
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : []
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
  private seq = 0

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : ""
      if (raw) this.handle(raw)
    })
    socket.addEventListener("close", () => this.failAll(new Error("cTrader connection closed")))
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
      this.pending.delete(clientMsgId)
      if (waiter) clearTimeout(waiter.timer)
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
    const symbols = await session.request(SYMBOLS_LIST_REQ, { ctidTraderAccountId: accountId }, [SYMBOLS_LIST_RES])
    const names = new Map<number, { name: string; digits: number; lotSize: number }>()
    for (const row of asArray(symbols.symbol)) {
      const symbolId = finite(row.symbolId)
      if (symbolId == null) continue
      names.set(symbolId, {
        name: String(row.symbolName ?? ""),
        digits: finite(row.digits) ?? 5,
        lotSize: finite(row.lotSize) ?? 0,
      })
    }
    const snapshot = await session.request(RECONCILE_REQ, { ctidTraderAccountId: accountId }, [RECONCILE_RES])
    const rows: Record<string, unknown>[] = []
    for (const position of asArray(snapshot.position)) {
      const trade = asRecord(position.tradeData)
      const symbol = names.get(finite(trade.symbolId) ?? -1)
      const digits = symbol?.digits ?? 5
      const lotSize = symbol?.lotSize || 1
      const volume = finite(trade.volume) ?? 0
      const price = finite(position.price)
      rows.push({
        ticket: finite(position.positionId) ?? 0,
        positionTicket: finite(position.positionId) ?? 0,
        symbol: symbol?.name ?? "",
        operation: operationName(trade.tradeSide),
        lots: volume / lotSize,
        openPrice: price == null ? undefined : price / 10 ** digits,
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
    const digits = finite(match?.digits) ?? 5
    const spot = await session.request(SUBSCRIBE_SPOTS_REQ, {
      ctidTraderAccountId: accountId,
      symbolId: [symbolId],
    }, [SPOT_EVENT])
    const bid = finite(spot.bid)
    const ask = finite(spot.ask)
    if (bid == null || ask == null) throw new Error("cTrader quote is missing prices")
    return {
      symbol: String(match?.symbolName ?? args.symbol),
      bid: bid / 10 ** digits,
      ask: ask / 10 ** digits,
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
  currency: string | undefined
  login: number | undefined
  status: Record<string, unknown>
} {
  const access = finite(trader.accessRights)
  const tradeAllowed = access == null || access === 0
  const balance = finite(trader.balance)
  const equity = finite(trader.equity)
  const money = (cents: number | undefined) => cents == null ? undefined : cents / 100
  const currency = trader.depositCurrency == null ? undefined : String(trader.depositCurrency)
  const login = finite(trader.traderLogin)
  return {
    healthy: tradeAllowed,
    tradeAllowed,
    balance: money(balance),
    equity: money(equity) ?? money(balance),
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
