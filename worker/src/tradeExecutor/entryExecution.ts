import type { TradeExecutorContext } from './context'
import type { SendOrderOutcome } from './types'
import { prepareEntryExecution, type EntryArgs, type PreparedEntry } from './entryPrepare'
import { placeStrictSignalEntryPending } from './strictEntryPending'
import { materializeVirtualPendingLegs } from './virtualPendingMaterialize'
import { sendImmediateLegs } from './orderLegExecution'

export type { EntryArgs } from './entryPrepare'

export type EntryMode = 'single' | 'range'

export async function finishEntrySend(
  prep: PreparedEntry,
  strictBrokerPlaced: boolean,
  materializedVirtuals: boolean,
  syncMultiLegTps: boolean,
): Promise<SendOrderOutcome> {
  return sendImmediateLegs({
    ctx: prep.ctx,
    signal: prep.signal,
    parsed: prep.parsed,
    broker: prep.broker,
    manual: prep.manual,
    api: prep.api,
    uuid: prep.uuid,
    symbol: prep.symbol,
    requestedSymbol: prep.requestedSymbol,
    mapping: prep.mapping,
    params: prep.params,
    legs: prep.legs,
    liveEntryFast: prep.liveEntryFast,
    pipelineT0: prep.pipelineT0,
    strictEntryPrefetch: prep.strictEntryPrefetch,
    channelDelayMs: prep.channelDelayMs,
    channelDelaySkipped: prep.channelDelaySkipped,
    deferVirtualAnchor: prep.deferVirtualAnchor,
    virtualPendings: prep.virtualPendings,
    plan: prep.plan,
    materializedVirtuals,
    strictBrokerPlaced,
    strictDeferred: prep.strictDeferred,
    op: prep.op,
    channelKeywords: prep.channelKeywords,
    baseLot: prep.baseLot,
    syncMultiLegTps,
  })
}

export async function executeEntrySend(
  ctx: TradeExecutorContext,
  args: EntryArgs,
  entryMode: EntryMode,
): Promise<SendOrderOutcome> {
  const prepared = await prepareEntryExecution(ctx, args)
  if (!prepared.ok) return prepared.outcome
  const prep = prepared.prep

  const strictBrokerPlaced = await placeStrictSignalEntryPending(ctx, prep, entryMode === 'single')
  const materializedVirtuals = await materializeVirtualPendingLegs(ctx, prep, strictBrokerPlaced)

  return finishEntrySend(prep, strictBrokerPlaced, materializedVirtuals, entryMode === 'range')
}
