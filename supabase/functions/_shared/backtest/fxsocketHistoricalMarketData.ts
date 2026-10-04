import type { FxsocketClient } from "../fxsocketClient.ts"
import { fxsocketMarketQueryRange, fxsocketTicksToMidPoints, toFxsocketTimeframe } from "./fxsocketMarketData.ts"
import type { HistoricalBar, HistoricalBarsRequest, HistoricalFetchResult, HistoricalMarketDataSource, HistoricalTicksRequest } from "./historicalMarketData.ts"
import type { PricePoint } from "./simulator.ts"

function validBar(bar: HistoricalBar): boolean {
  return Number.isFinite(bar.ts) && bar.ts > 0 &&
    Number.isFinite(bar.open) && bar.open > 0 &&
    Number.isFinite(bar.high) && bar.high > 0 &&
    Number.isFinite(bar.low) && bar.low > 0 &&
    Number.isFinite(bar.close) && bar.close > 0 &&
    bar.high >= bar.low
}

export class FxsocketHistoricalMarketData implements HistoricalMarketDataSource {
  readonly provider = "fxsocket" as const
  private readonly offsetCache = new Map<string, number>()

  constructor(private readonly client: FxsocketClient) {}

  async symbols(sessionId: string, platform: string | null): Promise<string[]> {
    return await this.client.symbols(sessionId, platform)
  }

  private async utcOffsetSeconds(
    sessionId: string,
    platform: string | null,
  ): Promise<number> {
    const key = `${sessionId}:${platform ?? ""}`
    const cached = this.offsetCache.get(key)
    if (cached != null) return cached
    let offset = 0
    try {
      const timezone = await this.client.serverTimezone(sessionId, platform)
      const parsed = Number(
        timezone.utcOffsetSeconds ?? timezone.utc_offset_seconds ?? 0,
      )
      if (Number.isFinite(parsed)) offset = parsed
    } catch {
      // Preserve the existing FXSocket behavior: timestamps fall back to UTC.
    }
    this.offsetCache.set(key, offset)
    return offset
  }

  async historicalBars(
    request: HistoricalBarsRequest,
  ): Promise<HistoricalFetchResult<HistoricalBar>> {
    const offsetSeconds = await this.utcOffsetSeconds(
      request.sessionId,
      request.platform,
    )
    const query = fxsocketMarketQueryRange(
      request.fromMs,
      request.toMs,
      offsetSeconds,
    )
    const raw = await this.client.priceHistory(request.sessionId, {
      symbol: request.symbol,
      timeframe: toFxsocketTimeframe(request.timeframe),
      from: query.from,
      to: query.to,
    }, request.platform)
    const offsetMs = offsetSeconds * 1000
    const data = raw.map((bar): HistoricalBar | null => {
      const parsed = Date.parse(bar.time)
      const normalized: HistoricalBar = {
        ts: parsed - offsetMs,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        ...(bar.spread != null && Number.isFinite(Number(bar.spread)) ? { spread: Number(bar.spread) } : {}),
      }
      return validBar(normalized) ? normalized : null
    }).filter((bar): bar is HistoricalBar => bar != null)
      .filter((bar) => bar.ts >= request.fromMs && bar.ts <= request.toMs)
      .sort((a, b) => a.ts - b.ts)
    return { data, requestCount: 1 }
  }

  async historicalTicks(
    request: HistoricalTicksRequest,
  ): Promise<HistoricalFetchResult<PricePoint>> {
    const offsetSeconds = await this.utcOffsetSeconds(
      request.sessionId,
      request.platform,
    )
    const query = fxsocketMarketQueryRange(
      request.fromMs,
      request.toMs,
      offsetSeconds,
    )
    const ticks = await this.client.quoteTicks(request.sessionId, {
      symbol: request.symbol,
      from: query.from,
      to: query.to,
    }, request.platform)
    return {
      data: fxsocketTicksToMidPoints(ticks, offsetSeconds)
        .filter((point) => point.ts >= request.fromMs && point.ts <= request.toMs),
      requestCount: 1,
    }
  }
}
