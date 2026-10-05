import { FxsocketClient, isFxsocketConfigured } from "../fxsocketClient.ts"
import { isMtapiConfigured, MtapiClient } from "../mtapiClient.ts"
import { FxsocketHistoricalMarketData } from "./fxsocketHistoricalMarketData.ts"
import type { HistoricalMarketDataSources } from "./historicalMarketData.ts"
import { createMtapiClockResolver, MtapiHistoricalMarketData } from "./mtapiMarketData.ts"

export function createHistoricalMarketDataSources(
  env: Deno.Env,
): HistoricalMarketDataSources {
  const sources: HistoricalMarketDataSources = {}
  if (isFxsocketConfigured(env)) {
    sources.fxsocket = new FxsocketHistoricalMarketData(
      new FxsocketClient(env),
    )
  }
  if (isMtapiConfigured(env)) {
    const client = new MtapiClient({ env })
    sources.mtapi = new MtapiHistoricalMarketData(
      client,
      createMtapiClockResolver(client, env),
    )
  }
  return sources
}
