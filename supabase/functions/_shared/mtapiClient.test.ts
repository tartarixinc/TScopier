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

Deno.test("orderHistory pages through OrderHistoryPagination when partial", async () => {
  const { client, calls } = provider(url => {
    if (url.pathname === "/OrderHistory") {
      return new Response(JSON.stringify({ partialResponse: true, orders: [{ ticket: 1 }] }))
    }
    if (url.pathname === "/OrderHistoryPagination") {
      assertEquals(url.searchParams.get("ordersPerPage"), "500")
      const page = Number(url.searchParams.get("pageNumber"))
      if (page === 0) {
        return new Response(JSON.stringify({ pagesCount: 2, orders: [{ ticket: 1 }, { ticket: 2 }] }))
      }
      return new Response(JSON.stringify({ pagesCount: 2, orders: [{ ticket: 3 }] }))
    }
    return new Response("unexpected endpoint", { status: 500 })
  })

  const rows = await client.orderHistory("s", "2000-01-01", "2026-09-25")
  // Probe page 0 rows are reused (start === 0), then page 1 is fetched
  // newest-first: [1, 2] + [3], two pagination requests total.
  assertEquals(
    rows.map(r => (r as { ticket: number }).ticket),
    [1, 2, 3],
  )
  assertEquals(
    calls.map(c => c.pathname),
    ["/OrderHistory", "/OrderHistoryPagination", "/OrderHistoryPagination"],
  )
})

Deno.test("orderHistory keeps truncated rows when pagination is unavailable", async () => {
  const { client } = provider(url => {
    if (url.pathname === "/OrderHistory") {
      return new Response(JSON.stringify({ partialResponse: true, orders: [{ ticket: 5 }] }))
    }
    return new Response("not found", { status: 404 })
  })

  const rows = await client.orderHistory("s", "2000-01-01", "2026-09-25")
  assertEquals(rows, [{ ticket: 5 }])
})

Deno.test("orderHistory capped pagination reads the newest window", async () => {
  const requested: number[] = []
  const { client } = provider(url => {
    if (url.pathname === "/OrderHistory") {
      return new Response(JSON.stringify({ partialResponse: true, orders: [{ ticket: 999 }] }))
    }
    if (url.pathname === "/OrderHistoryPagination") {
      const page = Number(url.searchParams.get("pageNumber"))
      requested.push(page)
      if (page === 0) {
        return new Response(JSON.stringify({ pagesCount: 45, orders: [{ ticket: 0 }] }))
      }
      return new Response(JSON.stringify({ orders: [{ ticket: page }] }))
    }
    return new Response("unexpected endpoint", { status: 500 })
  })

  const rows = await client.orderHistory("s", "2000-01-01", "2026-09-25")
  // 45 pages > 40-page cap → oldest page 0 is discarded and pages 5..44
  // (the newest window, 40 pages) are read, newest-first: probe(0) then
  // 44, 43, … 5.
  assertEquals(requested[0], 0)
  assertEquals(requested[1], 44)
  assertEquals(requested.length, 41)
  assertEquals(rows.length, 40)
  assertEquals((rows[0] as { ticket: number }).ticket, 44)
  assertEquals((rows[39] as { ticket: number }).ticket, 5)
})

Deno.test("orderHistory keeps fetched pages when an older page fails", async () => {
  const { client } = provider(url => {
    if (url.pathname === "/OrderHistory") {
      return new Response(JSON.stringify({ partialResponse: true, orders: [{ ticket: 999 }] }))
    }
    if (url.pathname === "/OrderHistoryPagination") {
      const page = Number(url.searchParams.get("pageNumber"))
      // Probe page 0 succeeds and is reused (start === 0); the newest page
      // (2) succeeds; the older refetched page (1) then fails — the catch
      // must keep the probe + newest pages instead of falling back to the
      // truncated rows.
      if (page === 0) {
        return new Response(JSON.stringify({ pagesCount: 3, orders: [{ ticket: 1 }, { ticket: 2 }] }))
      }
      if (page === 2) {
        return new Response(JSON.stringify({ pagesCount: 3, orders: [{ ticket: 3 }] }))
      }
      return new Response("not found", { status: 404 })
    }
    return new Response("unexpected endpoint", { status: 500 })
  })

  const rows = await client.orderHistory("s", "2000-01-01", "2026-09-25")
  assertEquals(rows.map(r => (r as { ticket: number }).ticket), [1, 2, 3])
})

Deno.test("orderHistory keeps truncated rows when pagination returns no rows", async () => {
  const { client } = provider(url => {
    if (url.pathname === "/OrderHistory") {
      return new Response(JSON.stringify({ partialResponse: true, orders: [{ ticket: 5 }] }))
    }
    if (url.pathname === "/OrderHistoryPagination") {
      return new Response(JSON.stringify({ pagesCount: 1, orders: [] }))
    }
    return new Response("unexpected endpoint", { status: 500 })
  })

  const rows = await client.orderHistory("s", "2000-01-01", "2026-09-25")
  assertEquals(rows, [{ ticket: 5 }])
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
