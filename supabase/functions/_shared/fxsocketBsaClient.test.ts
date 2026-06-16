import { assertEquals, assertRejects } from "jsr:@std/assert"
import {
  normalizeBsaSearchMt5Response,
  normalizeBsaSearchResponse,
  platformToBsaCode,
  searchBrokerCompanies,
  searchPlatformBrokerCompanies,
} from "./fxsocketBsaClient.ts"

Deno.test("platformToBsaCode maps MT4/MT5 to BSA codes", () => {
  assertEquals(platformToBsaCode("MT4"), "mt4")
  assertEquals(platformToBsaCode("mt4"), "mt4")
  assertEquals(platformToBsaCode("MT5"), "mt5")
  assertEquals(platformToBsaCode(""), "mt5")
})

Deno.test("normalizeBsaSearchResponse maps company and server fields", () => {
  const companies = normalizeBsaSearchResponse({
    result: [
      {
        company: "IC Markets",
        results: [
          {
            name: "ICMarketsSC-Demo",
            logo_url: "https://example.com/logo.png",
            site: "https://icmarkets.com",
            access: ["demo"],
          },
        ],
      },
    ],
  })

  assertEquals(companies.length, 1)
  assertEquals(companies[0].companyName, "IC Markets")
  assertEquals(companies[0].results?.[0]?.name, "ICMarketsSC-Demo")
  assertEquals(companies[0].results?.[0]?.logoUrl, "https://example.com/logo.png")
  assertEquals(companies[0].results?.[0]?.site, "https://icmarkets.com")
  assertEquals(companies[0].results?.[0]?.access, ["demo"])
})

Deno.test("normalizeBsaSearchMt5Response maps company names to server lists", () => {
  const companies = normalizeBsaSearchMt5Response([
    {
      "Vantage Global Prime": ["VantageMarkets-Live", "VantageMarkets-Demo"],
    },
    {
      "IC Markets": ["ICMarketsSC-MT5", "ICMarketsSC-MT5-Demo"],
    },
  ])

  assertEquals(companies.length, 2)
  assertEquals(companies[0].companyName, "Vantage Global Prime")
  assertEquals(companies[0].results?.map((r) => r.name), ["VantageMarkets-Live", "VantageMarkets-Demo"])
  assertEquals(companies[1].companyName, "IC Markets")
})

Deno.test("searchBrokerCompanies rejects short company fragments", async () => {
  const env = { get: () => "test-key" }
  await assertRejects(
    () => searchBrokerCompanies(env, { company: "abc" }),
    Error,
    "company must be at least 4 characters",
  )
})

Deno.test("searchPlatformBrokerCompanies uses /searchMt4 for MT4", async () => {
  const originalFetch = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (input: string | URL | Request) => {
    seen.push(String(input))
    return Promise.resolve(
      new Response(JSON.stringify([{ "IC Markets": ["ICMarketsSC-MT4"] }]), { status: 200 }),
    )
  }
  try {
    const env = { get: () => undefined }
    const companies = await searchPlatformBrokerCompanies(env, {
      company: "IC Markets",
      platform: "mt4",
    })
    assertEquals(seen.length, 1)
    assertEquals(seen[0]?.includes("/searchMt4?"), true)
    assertEquals(companies[0].results?.[0]?.name, "ICMarketsSC-MT4")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("searchPlatformBrokerCompanies uses /searchMt5 for MT5", async () => {
  const originalFetch = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = (input: string | URL | Request) => {
    seen.push(String(input))
    return Promise.resolve(
      new Response(JSON.stringify([{ "IC Markets": ["ICMarketsSC-MT5"] }]), { status: 200 }),
    )
  }
  try {
    const env = { get: () => undefined }
    const companies = await searchPlatformBrokerCompanies(env, {
      company: "IC Markets",
      platform: "mt5",
    })
    assertEquals(seen.length, 1)
    assertEquals(seen[0]?.includes("/searchMt5?"), true)
    assertEquals(companies[0].results?.[0]?.name, "ICMarketsSC-MT5")
  } finally {
    globalThis.fetch = originalFetch
  }
})
