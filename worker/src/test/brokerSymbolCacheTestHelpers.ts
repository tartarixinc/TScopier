import type { TradeExecutorContext } from '../tradeExecutor/context'

type BrokerSymbolCacheModule = typeof import('../tradeExecutor/brokerSymbolCache')

export async function runRepeatedSessionHeartbeatTicks(
  brokerSymbolCache: BrokerSymbolCacheModule,
  ctx: TradeExecutorContext,
  brokerUuid: string,
  times: number,
): Promise<void> {
  const ticks = Array.from({ length: times }, () => null)
  await ticks.reduce(
    (chain) => chain.then(async () => {
      ctx.sessionPingAt.delete(brokerUuid)
      await brokerSymbolCache.sessionHeartbeatTick(ctx)
    }),
    Promise.resolve(),
  )
}
