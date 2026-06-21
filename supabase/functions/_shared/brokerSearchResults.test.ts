import { assertEquals } from "jsr:@std/assert"
import {
  brokerSearchMatchScore,
  deriveBrokerSearchVariants,
  mergeBrokerSearchCompanies,
  partitionBrokerSearchResults,
} from "./brokerSearchResults.ts"
import type { BrokerSearchCompany } from "./fxsocketBsaClient.ts"

const vantageCompanies: BrokerSearchCompany[] = [
  {
    companyName: "Vantage Markets (Pty) Ltd",
    results: [
      { name: "VantageMarkets-Demo" },
      { name: "VantageMarkets-Live 2" },
      { name: "VantageMarkets-Live" },
    ],
  },
]

Deno.test("brokerSearchMatchScore matches server names with trailing numbers", () => {
  assertEquals(brokerSearchMatchScore("VantageMarkets-Demo", "VantageMarkets-Demo 2"), 90)
  assertEquals(brokerSearchMatchScore("VantageMarkets-Live 2", "VantageMarkets-Live 2"), 100)
})

Deno.test("partitionBrokerSearchResults expands related servers for numbered server queries", () => {
  const { serverHits, companyHits } = partitionBrokerSearchResults(
    "VantageMarkets-Demo 2",
    vantageCompanies,
  )

  assertEquals(serverHits.map((hit) => hit.serverName).includes("VantageMarkets-Demo"), true)
  assertEquals(serverHits.map((hit) => hit.serverName).includes("VantageMarkets-Live 2"), true)
  assertEquals(serverHits.length, 3)
  assertEquals(companyHits.length, 0)
})

Deno.test("partitionBrokerSearchResults keeps company browse rows for company queries", () => {
  const { serverHits, companyHits } = partitionBrokerSearchResults("Vantage Markets", vantageCompanies)

  assertEquals(serverHits.length, 0)
  assertEquals(companyHits.length, 1)
  assertEquals(companyHits[0]?.companyName, "Vantage Markets (Pty) Ltd")
})

Deno.test("deriveBrokerSearchVariants expands server-style queries", () => {
  const variants = deriveBrokerSearchVariants("VantageMarkets-Demo 2")
  assertEquals(variants.includes("VantageMarkets-Demo 2"), true)
  assertEquals(variants.includes("VantageMarkets-Demo"), true)
  assertEquals(variants.includes("VantageMarkets"), true)
})

Deno.test("mergeBrokerSearchCompanies deduplicates servers per company", () => {
  const merged = mergeBrokerSearchCompanies([
    [{ companyName: "Vantage Markets (Pty) Ltd", results: [{ name: "VantageMarkets-Demo" }] }],
    [{
      companyName: "Vantage Markets (Pty) Ltd",
      results: [{ name: "VantageMarkets-Demo" }, { name: "VantageMarkets-Live" }],
    }],
  ])

  assertEquals(merged.length, 1)
  assertEquals(merged[0]?.results?.map((row) => row.name), ["VantageMarkets-Demo", "VantageMarkets-Live"])
})
