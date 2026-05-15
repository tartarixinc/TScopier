import {
  extractServerNamesFromSearch,
  makeClientFromEnv,
  MetatraderApiError,
  type MetatraderApiClient,
  type MtPlatform,
} from "./metatraderapi.ts"
import { inferBrokerLabel } from "./brokerLabel.ts"

/** API requires company query length ≥ 4. */
const BROKER_NAMES = [
  "exnes", "icmar", "ftmo", "deriv", "eight", "peppe", "oanda", "fxtm", "admir",
  "tickm", "think", "vanta", "fusion", "globa", "justm", "black", "blueb", "dukas",
  "robom", "lmax", "fxdd", "vtmar", "olymp", "m4mar", "hfmar", "monex", "swiss",
  "axiom", "fpma", "fpmar", "xmcom", "hotfo", "octa", "weltr", "alpar", "insta",
  "nord", "easil", "capital", "markets", "prime", "group", "limited", "forex",
  "trade", "invest", "broker", "server", "demo", "live", "real", "trial", "meta",
  "quote", "inter", "natio", "servi", "finan", "holdi", "asset", "wealth", "credit",
  "bank", "union", "world", "direct", "activ", "prime", "global", "eight", "pepper",
]

function suffixTerms(suffix: string): string[] {
  return "abcdefghijklmnopqrstuvwxyz".split("").map((c) => `${c}${suffix}`)
}

export const MT_SERVER_SEARCH_TERMS: string[] = [
  ...new Set([
    ...BROKER_NAMES,
    ...suffixTerms("mark"),
    ...suffixTerms("ark"),
    ...suffixTerms("ive"),
    ...suffixTerms("emo"),
  ]),
].filter((t) => t.length >= 4)

export interface SyncMtServersResult {
  searchTerms: number
  mt4Names: number
  mt5Names: number
  upserted: number
  errors: string[]
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

async function searchAllTerms(
  client: MetatraderApiClient,
  terms: string[],
  errors: string[],
): Promise<Set<string>> {
  const names = new Set<string>()
  await runPool(terms, 6, async (term) => {
    try {
      const companies = await client.searchBrokers(term)
      for (const name of extractServerNamesFromSearch(companies)) {
        names.add(name)
      }
    } catch (e) {
      const msg = e instanceof MetatraderApiError ? e.message : String(e)
      if (!/at least 4/i.test(msg)) {
        errors.push(`${client.platform}/${term}: ${msg}`)
      }
    }
  })
  return names
}

export type MtServerUpsertRow = {
  server_name: string
  platform: MtPlatform | "ANY"
  source: string
  broker_label: string | null
  is_active: boolean
}

export function buildMtServerUpsertRows(
  mt4Names: Set<string>,
  mt5Names: Set<string>,
): MtServerUpsertRow[] {
  const all = new Set([...mt4Names, ...mt5Names])
  const rows: MtServerUpsertRow[] = []
  for (const server_name of all) {
    const on4 = mt4Names.has(server_name)
    const on5 = mt5Names.has(server_name)
    const platform: MtPlatform | "ANY" = on4 && on5 ? "ANY" : on5 ? "MT5" : "MT4"
    rows.push({
      server_name,
      platform,
      source: "mt4api_search",
      broker_label: inferBrokerLabel(server_name) || null,
      is_active: true,
    })
  }
  return rows
}

export async function collectMtServerRowsFromApi(
  env: { get(name: string): string | undefined },
  opts?: { terms?: string[] },
): Promise<{ stats: Omit<SyncMtServersResult, "upserted">; rows: MtServerUpsertRow[] }> {
  const terms = opts?.terms?.length ? opts.terms : MT_SERVER_SEARCH_TERMS
  const errors: string[] = []
  const mt4Client = makeClientFromEnv(env, "MT4")
  const mt5Client = makeClientFromEnv(env, "MT5")

  const [mt4Names, mt5Names] = await Promise.all([
    searchAllTerms(mt4Client, terms, errors),
    searchAllTerms(mt5Client, terms, errors),
  ])

  return {
    stats: {
      searchTerms: terms.length,
      mt4Names: mt4Names.size,
      mt5Names: mt5Names.size,
      errors,
    },
    rows: buildMtServerUpsertRows(mt4Names, mt5Names),
  }
}
