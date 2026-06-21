#!/usr/bin/env node
/**
 * Split entryExecution.ts into entryPrepare, rangeTradeExecutor helpers, strictEntryPending, thin entryExecution.
 */
import fs from 'fs'
import path from 'path'

const root = path.join(process.cwd(), 'src/tradeExecutor')
const src = fs.readFileSync(path.join(root, 'entryExecution.ts'), 'utf8')

// Line-based markers (1-indexed from read_file)
const PREP_START = src.indexOf('  const liveEntryFast = sendOpts?.liveEntryFast')
const MULTI_START = src.indexOf("  if (entryMode === 'range' && isManual && manual.trade_style === 'multi')")
const MULTI_END = src.indexOf('  if (isManual && !liveEntryFast) {\n    const already = await ctx.manualDispatchAlreadyMaterialized')
const PREP_END = src.indexOf('  // Strict entry: when the post-delay quote is not immediately fillable')
const STRICT_START = PREP_END
const STRICT_END = src.indexOf('  // ── Materialize virtual pendings into range_pending_legs')
const VIRT_START = STRICT_END
const VIRT_END = src.indexOf('  return sendImmediateLegs({')

if ([PREP_START, MULTI_START, MULTI_END, PREP_END, STRICT_END, VIRT_END].some(i => i < 0)) {
  throw new Error('markers not found')
}

const prepPart1 = src.slice(PREP_START, MULTI_START)
const prepPart2 = src.slice(MULTI_END, PREP_END)
const multiBlock = src.slice(MULTI_START, MULTI_END)
const strictBlock = src.slice(STRICT_START, STRICT_END)
const virtBlock = src.slice(VIRT_START, VIRT_END)
const sendCall = src.slice(VIRT_END)

const sharedImports = `import {
  hasFxsocketConfigured,
  isBrokerDisconnectedMessage,
  MT_SESSION_EXPIRED_HINT,
  FxsocketBrokerClient,
  MtOperation,
  OrderSendArgs,
} from '../fxsocketClient'
import {
  clampPendingExpiryHours,
  parsedHasExplicitEntryAnchor,
  planManualOrders,
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  signalEntryPriceStrictEnabled,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
  strictSignalEntryQuoteAllowsImmediate,
  lastPositiveParsedTpPrice,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerResult,
  type VirtualPendingLeg,
} from '../manualPlanner'
import { findActiveNewsBlackout } from '../newsTrading/blackout'
import { getCalendarEventsCached } from '../newsTrading/calendarProvider'
import { isNewsTradingEnabled } from '../newsTrading/settings'
import { shouldRouteAsBasketParameterRefresh } from '../multiTradeMerge'
import {
  applyChannelParamsToVirtualPendingList,
  loadChannelActiveTradeParamsForSymbol,
  mergeParsedWithChannelParams,
  parsedSignalHasExplicitStops,
  upsertChannelActiveTradeParams,
} from '../channelActiveTradeParams'
import { buildTscopierCommentPrefix } from '../tradeComment'
import type { TradeExecutorContext } from './context'
import { applySymbolMapping, computeCweTp, computeLot, isExcluded, roundLot, type Leg } from './helpers'
import type {
  BrokerRow,
  ParsedSignal,
  SendOrderOutcome,
  SignalRow,
  SymbolCacheEntry,
  SymbolMappingResult,
} from './types'
import type { EntryArgs } from './entryExecution'

export type PreparedEntry = {
  ctx: TradeExecutorContext
  signal: SignalRow
  parsed: ParsedSignal
  broker: BrokerRow
  manual: ManualSettings
  api: FxsocketBrokerClient
  uuid: string
  symbol: string
  requestedSymbol: string
  mapping: SymbolMappingResult
  params: SymbolCacheEntry | null
  liveEntryFast: boolean
  pipelineT0?: number
  strictEntryPrefetch: { bid: number; ask: number } | null
  commentPrefix: string
  channelDelayMs: number
  channelDelaySkipped: boolean
  plan: PlannerResult
  capped: OrderSendArgs[]
  virtualPendings: VirtualPendingLeg[]
  legs: Leg[]
  deferVirtualAnchor: boolean
  strictDeferred: boolean
  op: MtOperation
  channelKeywords: ChannelKeywords | null
  baseLot: number
  anchor: number | null
  anchorSource: 'signal' | 'quote' | 'unknown'
  isManual: boolean
}

export type PrepareEntryResult =
  | { ok: false; outcome: SendOrderOutcome }
  | { ok: true; prep: PreparedEntry }

`

const prepareFn = `export async function prepareEntryExecution(
  ctx: TradeExecutorContext,
  args: EntryArgs,
): Promise<PrepareEntryResult> {
  const { signal, parsed, op, broker, channelKeywords, pipelineT0, sendOpts } = args
${prepPart1}${prepPart2}
  return {
    ok: true,
    prep: {
      ctx,
      signal,
      parsed,
      broker,
      manual,
      api,
      uuid,
      symbol,
      requestedSymbol,
      mapping,
      params,
      liveEntryFast,
      pipelineT0,
      strictEntryPrefetch,
      commentPrefix,
      channelDelayMs,
      channelDelaySkipped,
      plan,
      capped,
      virtualPendings,
      legs,
      deferVirtualAnchor,
      strictDeferred,
      op,
      channelKeywords,
      baseLot,
      anchor,
      anchorSource,
      isManual,
    },
  }
}
`

// Fix early returns in prepare body to return { ok: false, outcome: ... }
let prepareBody = prepareFn
prepareBody = prepareBody.replace(
  /(\n  if \(!hasFxsocketConfigured\(\)\) return \{\})/,
  '\n  if (!hasFxsocketConfigured()) return { ok: false, outcome: {} }',
)
prepareBody = prepareBody.replace(
  /(\n  if \(!api\) return \{\})/g,
  '\n  if (!api) return { ok: false, outcome: {} }',
)
prepareBody = prepareBody.replace(
  /return \{\}(\n)/g,
  'return { ok: false, outcome: {} }$1',
)
// Fix specific returns that aren't empty
prepareBody = prepareBody.replace(
  'return { openedOrMerged: true }',
  'return { ok: false, outcome: { openedOrMerged: true } }',
)
prepareBody = prepareBody.replace(
  'return { openedOrMerged: false }',
  'return { ok: false, outcome: { openedOrMerged: false } }',
)
prepareBody = prepareBody.replace(
  /return \{ finalizeSkipReason: ([^}]+) \}/g,
  'return { ok: false, outcome: { finalizeSkipReason: $1 } }',
)
prepareBody = prepareBody.replace(
  'return entryStrict ? { signalEntryRequiredSkip: true } : {}',
  'return { ok: false, outcome: entryStrict ? { signalEntryRequiredSkip: true } : {} }',
)
// Don't double-wrap the final return
prepareBody = prepareBody.replace(
  'return { ok: false, outcome: { ok: true, prep:',
  'return { ok: true, prep:',
)

fs.writeFileSync(path.join(root, 'entryPrepare.ts'), sharedImports + prepareBody)

// rangeTradeExecutor - multi log + virtual materialize
const rangeImports = `import type { OrderSendArgs } from '../fxsocketClient'
import type { ManualSettings, PlannerResult, VirtualPendingLeg } from '../manualPlanner'
import type { TradeExecutorContext } from './context'
import { roundLot, triggerPriceFor } from './helpers'
import type { ParsedSignal, SignalRow } from './types'
import type { PreparedEntry } from './entryPrepare'
import type { EntryArgs } from './entryExecution'
import { prepareEntryExecution } from './entryPrepare'
import { placeStrictSignalEntryPending } from './strictEntryPending'
import { sendImmediateLegs } from './orderLegExecution'

`

const multiFn = multiBlock
  .replace("  if (entryMode === 'range' && isManual && manual.trade_style === 'multi') {", '')
  .replace(/^  /gm, '  ')

const logMulti = `export async function logMultiRangePlan(
  ctx: TradeExecutorContext,
  prep: PreparedEntry,
): Promise<void> {
  const { signal, broker, manual, parsed, plan, capped, virtualPendings, baseLot, symbol, liveEntryFast } = prep
  if (!prep.isManual || manual.trade_style !== 'multi') return
${multiFn}
}
`

const virtFn = virtBlock
  .replace(/^  /gm, '  ')
  .replace(
    'let materializedVirtuals = false',
    'export async function materializeVirtualPendingLegs(\n  ctx: TradeExecutorContext,\n  prep: PreparedEntry,\n  strictBrokerPlaced: boolean,\n): Promise<boolean> {\n  const {\n    signal, broker, uuid, symbol, virtualPendings, deferVirtualAnchor, anchor, anchorSource,\n    params, plan, liveEntryFast, strictDeferred,\n  } = prep\n  let materializedVirtuals = false',
  )

const strictImports = `import {
  FxsocketBrokerClient,
  MtOperation,
  OrderSendArgs,
} from '../fxsocketClient'
import {
  clampPendingExpiryHours,
  lastPositiveParsedTpPrice,
  type ManualSettings,
  type PlannerResult,
} from '../manualPlanner'
import { autoManagementTradeSnapshot } from '../autoManagement'
import type { TradeExecutorContext } from './context'
import { clampOrderStops, roundLot } from './helpers'
import type { BrokerRow, ParsedSignal, SignalRow, SymbolCacheEntry } from './types'
import type { PreparedEntry } from './entryPrepare'

`

const strictFn = strictBlock
  .replace(/^  \/\/ Strict entry:.*\n/, '')
  .replace('let strictBrokerPlaced = false\n', '')
  .replace(
    'if (strictDeferred && plan.strictEntry && capped.length > 0 && api) {',
    `export async function placeStrictSignalEntryPending(
  ctx: TradeExecutorContext,
  prep: PreparedEntry,
  singleTpOverride: boolean,
): Promise<boolean> {
  const {
    signal, parsed, broker, manual, api, uuid, symbol, params, plan, capped,
    strictDeferred, commentPrefix,
  } = prep
  if (!strictDeferred || !plan.strictEntry || capped.length === 0 || !api) return false
  let strictBrokerPlaced = false
  {`,
  )
  .replace('const isSingleTradeStyle = entryMode === \'single\'', 'const isSingleTradeStyle = singleTpOverride')
  .replace(/\bplan\./g, 'prep.plan.')
  .replace(/\bcapped\b/g, 'prep.capped')
  .replace(/\bparams\b/g, 'prep.params')
  .replace(/\bapi\b/g, 'ctx.apiFor(prep.broker)!')
  // fix double prep.plan
  .replace(/prep\.prep\./g, 'prep.')

// Close strict function with return
let strictFnFixed = strictFn
if (!strictFnFixed.trimEnd().endsWith('return strictBrokerPlaced\n}')) {
  strictFnFixed = strictFnFixed.replace(/\n  \}\n\n  \/\/ ── Materialize/, '\n  }\n  return strictBrokerPlaced\n}\n\n// PLACEHOLDER')
}

fs.writeFileSync(path.join(root, 'strictEntryPending.ts'), strictImports + strictFnFixed.replace('// PLACEHOLDER', ''))

fs.writeFileSync(
  path.join(root, 'rangeTradeExecutor.ts'),
  rangeImports
  + logMulti
  + '\n\n'
  + virtFn
  + `

export async function runRangeEntry(
  ctx: TradeExecutorContext,
  args: EntryArgs,
): Promise<import('./types').SendOrderOutcome> {
  const prepared = await prepareEntryExecution(ctx, args)
  if (!prepared.ok) return prepared.outcome
  const prep = prepared.prep

  await logMultiRangePlan(ctx, prep)

  const strictBrokerPlaced = await placeStrictSignalEntryPending(ctx, prep, false)
  const materializedVirtuals = await materializeVirtualPendingLegs(ctx, prep, strictBrokerPlaced)

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
    syncMultiLegTps: true,
  })
}
`,
)

// single path orchestrator in entryExecution
const entryOrchestrator = `import type { TradeExecutorContext } from './context'
import type { SendOrderOutcome } from './types'
import { prepareEntryExecution } from './entryPrepare'
import { placeStrictSignalEntryPending } from './strictEntryPending'
import { materializeVirtualPendingLegs } from './rangeTradeExecutor'
import { sendImmediateLegs } from './orderLegExecution'

export type EntryArgs = {
  signal: import('./types').SignalRow
  parsed: import('./types').ParsedSignal
  op: import('../fxsocketClient').MtOperation
  broker: import('./types').BrokerRow
  channelKeywords: import('../manualPlanner').ChannelKeywords | null
  pipelineT0?: number
  sendOpts?: { liveEntryFast?: boolean; commentPrefix?: string }
}

export type EntryMode = 'single' | 'range'

async function finishEntrySend(
  prep: import('./entryPrepare').PreparedEntry,
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
`

fs.writeFileSync(path.join(root, 'entryExecution.ts'), entryOrchestrator)

console.log('wrote entryPrepare.ts', (sharedImports + prepareBody).split('\n').length, 'lines')
console.log('wrote entryExecution.ts', entryOrchestrator.split('\n').length, 'lines')
