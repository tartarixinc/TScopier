import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { MtapiClient, MtapiApiError, normalizeMtapiAccountSummary, isMtapiConfigured } from "./mtapiClient.ts"

function makeEnv(vars: Record<string, string>): Deno.Env {
  return {
    get: (name: string) => vars[name],
  } as unknown as Deno.Env
}

function provider(handler: (url: URL) => Response, vars: Record<string, string> = { MTAPI_BASE_URL: "https://mtapi.test" }) {
  const calls: URL[] = []
  const client = new MtapiClient({
    env: makeEnv(vars),
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(String(input))
      calls.push(url)
      return handler(url)
    }) as typeof fetch,
  })
  return { client, calls }
}

Deno.test("isMtapiConfigured requires MTAPI_BASE_URL", () => {
  assertEquals(isMtapiConfigured(makeEnv({})), false)
  assertEquals(isMtapiConfigured(makeEnv({ MTAPI_BASE_URL: "https://mtapi.test" })), true)
})

Deno.test("openedOrders unwraps orders list and passes session id", async () => {
  const { client, calls } = provider(url => {
    assertEquals(url.pathname, "/OpenedOrders")
    assertEquals(url.searchParams.get("id"), "sess-1")
    return new Response(JSON.stringify({ orders: [{ ticket: 1 }] }))
  })
  assertEquals(await client.openedOrders("sess-1"), [{ ticket: 1 }])
  assertEquals(calls.length, 1)
})

Deno.test("orderHistory and positionHistory pass date range", async () => {
  const { client, calls } = provider(url => {
    if (url.pathname === "/OrderHistory") {
      return new Response(JSON.stringify({ orders: [{ ticket: 9 }] }))
    }
    return new Response(JSON.stringify({ positions: [{ ticket: 7 }] }))
  })
  assertEquals(await client.orderHistory("s", "2000-01-01", "2026-09-23"), [{ ticket: 9 }])
  assertEquals(await client.positionHistory("s", "2000-01-01", "2026-09-23"), [{ ticket: 7 }])
  assertEquals(calls[0].searchParams.get("from"), "2000-01-01")
  assertEquals(calls[0].searchParams.get("to"), "2026-09-23")
  assertEquals(calls[1].pathname, "/HistoryPositions")
})

Deno.test("getQuote normalizes GetQuote bid/ask", async () => {
  const { client, calls } = provider(url => {
    assertEquals(url.pathname, "/GetQuote")
    assertEquals(url.searchParams.get("symbol"), "XAUUSD")
    assertEquals(url.searchParams.get("id"), "sess-q")
    return new Response(JSON.stringify({ Bid: 4290.1, Ask: 4290.4, Symbol: "XAUUSD", time: "12:00:00" }))
  })
  assertEquals(await client.getQuote("sess-q", "XAUUSD"), {
    symbol: "XAUUSD",
    bid: 4290.1,
    ask: 4290.4,
    time: "12:00:00",
  })
  assertEquals(calls.length, 1)
})

Deno.test("getQuote rejects invalid prices", async () => {
  const { client } = provider(() => new Response(JSON.stringify({ bid: 0, ask: -1 })))
  await assertRejectsLike(() => client.getQuote("s", "EURUSD"), MtapiApiError, "invalid prices")
})

Deno.test("missing MTAPI_BASE_URL throws NOT_CONFIGURED", async () => {
  const { client } = provider(() => new Response("[]"), { MTAPI_PROXY_KEY: "k" })
  await assertRejectsLike(
    () => client.openedOrders("s"),
    MtapiApiError,
    "MTAPI is not configured",
  )
})

Deno.test("MTAPI error code in body surfaces as MtapiApiError", async () => {
  const { client } = provider(() =>
    new Response(JSON.stringify({ error: "INVALID_TOKEN", message: "gone" }), { status: 201 })
  )
  await assertRejectsLike(() => client.openedOrders("s"), MtapiApiError, "gone")
})

Deno.test("normalizeMtapiAccountSummary maps FxSocket summary fields", () => {
  const summary = normalizeMtapiAccountSummary({
    Balance: 1000,
    Credit: 50,
    Profit: -10,
    Equity: 1040,
    currency: "USD",
  })
  assertEquals(summary.balance, 1000)
  assertEquals(summary.credit, 50)
  assertEquals(summary.equity, 1040)
  assertEquals(summary.currency, "USD")
})

Deno.test("Authorization bearer uses MTAPI_PROXY_KEY when set", async () => {
  let auth: string | null = null
  const { client } = provider(url => {
    void url
    return new Response("[]")
  }, {
    MTAPI_BASE_URL: "https://mtapi.test",
    MTAPI_PROXY_KEY: "proxy-key",
  })
  // intercept via fetchImpl already bound — re-create with header capture
  const c2 = new MtapiClient({
    env: makeEnv({ MTAPI_BASE_URL: "https://mtapi.test", MTAPI_PROXY_KEY: "proxy-key" }),
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      auth = headers["Authorization"] ?? null
      return new Response("[]")
    }) as typeof fetch,
  })
  await c2.openedOrders("s")
  assertEquals(auth, "Bearer proxy-key")
  await client.openedOrders("s")
})

Deno.test("X-Internal-Token header is sent when MTAPI_INTERNAL_TOKEN is set", async () => {
  let token: string | null = null
  const client = new MtapiClient({
    env: makeEnv({
      MTAPI_BASE_URL: "https://mtapi.test",
      MTAPI_API_KEY: "api-key",
      MTAPI_INTERNAL_TOKEN: "internal-secret",
    }),
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      token = headers["X-Internal-Token"] ?? null
      return new Response("[]")
    }) as typeof fetch,
  })
  await client.openedOrders("s")
  assertEquals(token, "internal-secret")
})

Deno.test("X-Internal-Token header is omitted when MTAPI_INTERNAL_TOKEN is unset", async () => {
  let hasToken = false
  const client = new MtapiClient({
    env: makeEnv({ MTAPI_BASE_URL: "https://mtapi.test", MTAPI_API_KEY: "api-key" }),
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      hasToken = "X-Internal-Token" in headers
      return new Response("[]")
    }) as typeof fetch,
  })
  await client.openedOrders("s")
  assertEquals(hasToken, false)
})

Deno.test("X-Internal-Token header is omitted for whitespace-only MTAPI_INTERNAL_TOKEN", async () => {
  let hasToken = false
  const client = new MtapiClient({
    env: makeEnv({
      MTAPI_BASE_URL: "https://mtapi.test",
      MTAPI_API_KEY: "api-key",
      MTAPI_INTERNAL_TOKEN: "   ",
    }),
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      hasToken = "X-Internal-Token" in headers
      return new Response("[]")
    }) as typeof fetch,
  })
  await client.openedOrders("s")
  assertEquals(hasToken, false)
})

async function assertRejectsLike<T>(
  fn: () => Promise<T>,
  Ctor: new (...args: never[]) => Error,
  messagePart: string,
) {
  try {
    await fn()
    throw new Error("expected rejection")
  } catch (e) {
    if (!(e instanceof Ctor)) throw e
    assertStringIncludes(e.message, messagePart)
  }
}
