import { assertEquals, assertThrows } from "jsr:@std/assert"
import {
  accountApiPathSegment,
  buildV1CreateAccountBody,
  getFxsocketV1BaseUrl,
  isAccountSummaryReady,
  isV1AccountLinkPending,
  normalizeAccountSummary,
  normalizeOrderResponse,
  normalizeV1Account,
  parsePriceHistoryResponse,
  parseQuoteTicksResponse,
  trimPreview,
} from "./fxsocketClient.ts"

Deno.test("normalizeAccountSummary maps FxSocket AccountSummary JSON", () => {
  const summary = normalizeAccountSummary({
    balance: 9686.15,
    equity: 9686.15,
    currency: "USD",
    type: "Demo",
    freeMargin: 9686.15,
  })
  assertEquals(summary.balance, 9686.15)
  assertEquals(summary.currency, "USD")
  assertEquals(summary.type, "Demo")
  assertEquals(summary.freeMargin, 9686.15)
})

Deno.test("normalizeOrderResponse reads success and ticket fields", () => {
  const order = normalizeOrderResponse({
    success: true,
    retcode: 10009,
    deal: 211438760,
    order: 211438761,
    volume: 0.1,
    price: 1.15333,
  })
  assertEquals(order.success, true)
  assertEquals(order.retcode, 10009)
  assertEquals(order.deal, 211438760)
  assertEquals(order.order, 211438761)
})

Deno.test("trimPreview truncates large payloads", () => {
  const big = { data: "x".repeat(500) }
  const preview = trimPreview(big, 80)
  assertEquals(typeof preview, "object")
  assertEquals("_preview" in (preview as Record<string, unknown>), true)
})

Deno.test("getFxsocketV1BaseUrl defaults to api.fxsocket.com/v1", () => {
  const env = { get: () => undefined }
  assertEquals(getFxsocketV1BaseUrl(env), "https://api.fxsocket.com/v1")
})

Deno.test("buildV1CreateAccountBody matches v1 OpenAPI schema", () => {
  const body = buildV1CreateAccountBody({
    login: "12345678",
    password: "secret",
    server: "ICMarkets-Demo",
    nickname: "Demo",
  })
  assertEquals(body.login, 12345678)
  assertEquals(body.password, "secret")
  assertEquals(body.server, "ICMarkets-Demo")
  assertEquals(body.nickname, "Demo")
})

Deno.test("buildV1CreateAccountBody includes platform when provided", () => {
  const body = buildV1CreateAccountBody({
    login: "12345678",
    password: "secret",
    server: "ICMarkets-Demo",
    platform: "MT4",
  })
  assertEquals(body.platform, "mt4")
})

Deno.test("accountApiPathSegment maps MT4/MT5 to REST path segment", () => {
  assertEquals(accountApiPathSegment("MT4"), "mt4")
  assertEquals(accountApiPathSegment("mt4"), "mt4")
  assertEquals(accountApiPathSegment("MT5"), "mt5")
  assertEquals(accountApiPathSegment(null), "mt5")
})

Deno.test("buildV1CreateAccountBody rejects invalid login", () => {
  assertThrows(
    () => buildV1CreateAccountBody({ login: "abc", password: "x", server: "S" }),
    Error,
    "Invalid MT login number",
  )
})

Deno.test("normalizeV1Account maps POST /v1/accounts response", () => {
  const acct = normalizeV1Account({
    id: "11111111-2222-3333-4444-555555555555",
    nickname: "Demo",
    platform: "mt5",
    server: "Broker-Demo",
    login: 12345,
    status: "connecting",
    error: "",
    created_at: "2026-06-12T12:00:00Z",
  })
  assertEquals(acct.id, "11111111-2222-3333-4444-555555555555")
  assertEquals(acct.status, "connecting")
  assertEquals(acct.login, 12345)
})

Deno.test("isV1AccountLinkPending treats connecting and sent as pending", () => {
  assertEquals(isV1AccountLinkPending(normalizeV1Account({ status: "connecting" })), true)
  assertEquals(isV1AccountLinkPending(normalizeV1Account({ status: "sent" })), true)
  assertEquals(isV1AccountLinkPending(normalizeV1Account({ status: "connected" })), false)
})

Deno.test("isAccountSummaryReady requires balance or equity", () => {
  assertEquals(isAccountSummaryReady({ balance: 1000 }), true)
  assertEquals(isAccountSummaryReady({ equity: 0 }), true)
  assertEquals(isAccountSummaryReady({ currency: "USD" }), false)
})

Deno.test("parsePriceHistoryResponse returns empty for non-array", () => {
  assertEquals(parsePriceHistoryResponse(null), [])
  assertEquals(parsePriceHistoryResponse({ error: "MRPC" }), [])
})

Deno.test("parseQuoteTicksResponse skips invalid rows", () => {
  assertEquals(parseQuoteTicksResponse([{ bid: 1.1 }]), [])
})
