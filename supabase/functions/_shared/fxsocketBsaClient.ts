/**
 * FxSocket Broker Search API (BSA).
 * Docs: https://bsa.fxsocket.com/docs
 */

import { FxsocketApiError, resolveFxsocketApiKey } from "./fxsocketClient.ts"
import {
  deriveBrokerSearchVariants,
  mergeBrokerSearchCompanies,
} from "./brokerSearchResults.ts"

type EnvGetter = { get(name: string): string | undefined }

const DEFAULT_BSA_BASE_URL = "https://bsa.fxsocket.com"

export type BsaPlatformCode = "mt4" | "mt5"

export interface BsaBrokerServer {
  name: string
  logo_url?: string | null
  site?: string | null
  access?: string[]
}

export interface BsaBrokerCompany {
  company: string
  results?: BsaBrokerServer[]
}

export interface BsaSearchResponse {
  result?: BsaBrokerCompany[]
}

export interface BrokerSearchResult {
  name?: string
  access?: string[]
  logoUrl?: string | null
  site?: string | null
}

export interface BrokerSearchCompany {
  companyName?: string
  results?: BrokerSearchResult[]
}

function getBsaBaseUrl(env: EnvGetter): string {
  const raw = (env.get("FXSOCKET_BSA_BASE_URL") ?? "").trim()
  return (raw || DEFAULT_BSA_BASE_URL).replace(/\/+$/, "")
}

export function platformToBsaCode(platform: string): BsaPlatformCode {
  return String(platform).toUpperCase() === "MT4" ? "mt4" : "mt5"
}

export function normalizeBsaSearchResponse(raw: BsaSearchResponse): BrokerSearchCompany[] {
  return (raw.result ?? []).map((row) => ({
    companyName: row.company,
    results: (row.results ?? []).map((server) => ({
      name: server.name,
      access: server.access ?? [],
      logoUrl: server.logo_url ?? null,
      site: server.site ?? null,
    })),
  }))
}

/** Response shape from GET /searchMt5 and GET /searchMt4 — `[{ "Company Name": ["Server-A", "Server-B"] }]`. */
export type BsaSearchMt5Response = Array<Record<string, string[]>>

export function normalizeBsaSearchMt5Response(raw: BsaSearchMt5Response): BrokerSearchCompany[] {
  const companies: BrokerSearchCompany[] = []
  for (const row of raw ?? []) {
    if (!row || typeof row !== "object") continue
    for (const [companyName, servers] of Object.entries(row)) {
      const names = (servers ?? []).map((name) => String(name).trim()).filter(Boolean)
      if (names.length === 0) continue
      companies.push({
        companyName,
        results: names.map((name) => ({ name, access: [] })),
      })
    }
  }
  return companies
}

export async function searchBrokerCompanies(
  env: EnvGetter,
  args: { company: string; code?: BsaPlatformCode },
): Promise<BrokerSearchCompany[]> {
  const company = args.company.trim()
  if (company.length < 4) {
    throw new FxsocketApiError("company must be at least 4 characters", 400)
  }

  const code = args.code ?? "mt5"
  const apiKey = resolveFxsocketApiKey(env)
  const url = new URL(`${getBsaBaseUrl(env)}/search`)
  url.searchParams.set("company", company)
  url.searchParams.set("code", code)

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "X-API-Key": apiKey },
  })

  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in (body as Record<string, unknown>)
      ? String((body as Record<string, unknown>).detail)
      : text || `HTTP ${res.status}`
    throw new FxsocketApiError(`Broker search failed: ${detail}`, res.status)
  }

  return normalizeBsaSearchResponse((body ?? {}) as BsaSearchResponse)
}

/**
 * MT4/MT5 broker + server search (public BSA endpoints).
 * Docs: https://bsa.fxsocket.com/docs#/default/search_mt4_searchMt4_get
 * Docs: https://bsa.fxsocket.com/docs#/default/search_mt5_searchMt5_get
 */
export async function searchPlatformBrokerCompanies(
  env: EnvGetter,
  args: { company: string; platform?: BsaPlatformCode },
): Promise<BrokerSearchCompany[]> {
  const company = args.company.trim()
  if (company.length < 4) {
    throw new FxsocketApiError("company must be at least 4 characters", 400)
  }

  const platform = args.platform ?? "mt5"
  const path = platform === "mt4" ? "searchMt4" : "searchMt5"
  const url = new URL(`${getBsaBaseUrl(env)}/${path}`)
  url.searchParams.set("company", company)

  const res = await fetch(url.toString(), { method: "GET" })

  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  if (!res.ok) {
    const detail = body && typeof body === "object" && "detail" in (body as Record<string, unknown>)
      ? String((body as Record<string, unknown>).detail)
      : text || `HTTP ${res.status}`
    throw new FxsocketApiError(`Broker search failed: ${detail}`, res.status)
  }

  if (!Array.isArray(body)) {
    return []
  }

  return normalizeBsaSearchMt5Response(body as BsaSearchMt5Response)
}

/** @deprecated Use searchPlatformBrokerCompanies with platform mt5 */
export async function searchMt5BrokerCompanies(
  env: EnvGetter,
  args: { company: string },
): Promise<BrokerSearchCompany[]> {
  return searchPlatformBrokerCompanies(env, { company: args.company, platform: "mt5" })
}

export async function searchMt4BrokerCompanies(
  env: EnvGetter,
  args: { company: string },
): Promise<BrokerSearchCompany[]> {
  return searchPlatformBrokerCompanies(env, { company: args.company, platform: "mt4" })
}

/**
 * Search by company or server name — runs multiple BSA fragments and merges results.
 * The public /searchMt4 and /searchMt5 endpoints only accept company-name fragments, so
 * server-style queries (e.g. "VantageMarkets-Demo 2") are expanded into shorter variants first.
 */
export async function searchBrokerDirectory(
  env: EnvGetter,
  args: { query: string; platform?: string },
): Promise<BrokerSearchCompany[]> {
  const query = args.query.trim()
  if (query.length < 4) {
    throw new FxsocketApiError("query must be at least 4 characters", 400)
  }

  const platform = platformToBsaCode(args.platform ?? "MT5")
  const variants = deriveBrokerSearchVariants(query)
  const batches = await Promise.all(
    variants.map((variant) =>
      searchPlatformBrokerCompanies(env, { company: variant, platform }).catch(
        () => [] as BrokerSearchCompany[],
      )
    ),
  )

  return mergeBrokerSearchCompanies(batches)
}
