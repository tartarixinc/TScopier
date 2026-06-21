#!/usr/bin/env node
/**
 * Mechanical split of TradeExecutor.ts into tradeExecutor/* modules.
 * Run from worker/: node scripts/split-trade-executor.mjs
 */
import fs from 'fs'
import path from 'path'

const root = path.join(process.cwd(), 'src/tradeExecutor')
const srcPath = path.join(root, 'TradeExecutor.ts')
let src = fs.readFileSync(srcPath, 'utf8')
const importEnd = src.indexOf('/** When true (default), channel-attached')
const SHARED_IMPORTS = importEnd > 0 ? src.slice(0, importEnd).trim() : ''

const phase1Header = `import { invalidateChannelParseCache } from '../channelKeywordsCache'
import {
  applySymbolMapping,
  brokerOrderOpenMs,
  clampOrderStops,
  computeCweTp,
  computeLot,
  isBuySideOp,
  isExcluded,
  isMtUuid,
  operationFor,
  parseSymbolToTradeList,
  roundLot,
  triggerPriceFor,
  type Leg,
} from './helpers'
import {
  BROKER_SESSION_HEARTBEAT_MS,
  EXECUTION_LOG_ACTIONS_HANDLED,
  EXECUTOR_MAX_CONCURRENT_SIGNALS,
  EXECUTOR_PARSED_SWEEP_MS,
  EXECUTOR_REPLAY_MAX_AGE_MS,
  EXECUTOR_SWEEP_IDLE_MS,
  PARSED_STATUSES,
  SESSION_PING_MIN_INTERVAL_MS,
  SYMBOL_CACHE_KEEPALIVE_MS,
  SYMBOL_CACHE_STALE_MS,
  SYMBOL_CACHE_TTL_MS,
  SYMBOL_LIST_TTL_MS,
  telegramLiveTradeGateEnabled,
  type BrokerRow,
  type MergeOutcome,
  type ParsedSignal,
  type RangePendingCancelScope,
  type SendOrderOutcome,
  type SignalRow,
  type SymbolCacheEntry,
  type SymbolListCacheEntry,
} from './types'
import * as brokerSymbolCache from './brokerSymbolCache'
import * as dispatch from './dispatch'
import * as basketMerge from './basketMerge'
import * as managementExecutor from './managementExecutor'
import { runSingleEntry, runRangeEntry } from './entryRouter'

export type { SignalRow } from './types'
`

// Remove duplicate top-level definitions (phase 1)
const cutStart = src.indexOf('/** When true (default), channel-attached')
const classStart = src.indexOf('export class TradeExecutor')
if (cutStart < 0 || classStart < 0) throw new Error('phase1 markers not found')
src = src.slice(0, cutStart) + phase1Header + '\n' + src.slice(classStart)

// Remove computeCwOverrideTp from manualPlanner import if present
src = src.replace(
  /import \{\n  clampPendingExpiryHours,\n  computeCwOverrideTp,\n  parsedHasExplicitEntryAnchor,/,
  'import {\n  clampPendingExpiryHours,\n  parsedHasExplicitEntryAnchor,',
)

function findMethodBodyBrace(startIdx) {
  let i = src.indexOf('(', startIdx)
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) { i++; break; }
    }
  }
  let k = i
  while (k < src.length && /\s/.test(src[k])) k++
  if (src[k] === ':') {
    k++
    while (k < src.length && /\s/.test(src[k])) k++
    if (src.slice(k, k + 7) === 'Promise') {
      k += 7
      while (k < src.length && /\s/.test(src[k])) k++
      if (src[k] === '<') {
        let d = 1
        k++
        while (k < src.length && d > 0) {
          if (src[k] === '<') d++
          else if (src[k] === '>') d--
          k++
        }
      }
    } else {
      while (k < src.length && src[k] !== '{') k++
    }
  }
  while (k < src.length && /\s/.test(src[k])) k++
  return src[k] === '{' ? k : -1
}

function extractMethod(name) {
  const sigRe = new RegExp(`^  (?:private async |private )${name}\\(`, 'm')
  const m = src.match(sigRe)
  if (!m) return null
  const bodyBrace = findMethodBodyBrace(m.index)
  if (bodyBrace < 0) return null
  let depth = 0
  let j = bodyBrace
  for (; j < src.length; j++) {
    const c = src[j]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { j++; break; }
    }
  }
  const text = src.slice(m.index, j)
  const head = src.slice(m.index, bodyBrace)
  const params = head.slice(head.indexOf('(') + 1, head.lastIndexOf(')')).trim()
  const isAsync = head.includes('private async')
  const retMatch = head.match(/\)\s*:\s*([\s\S]+)$/)
  const retType = retMatch ? retMatch[1].trim() : ''
  return { name, start: m.index, end: j, text, params, isAsync, retType }
}

function stripParamName(p) {
  let s = p.trim().split('=')[0].trim()
  const colon = s.indexOf(':')
  if (colon >= 0) s = s.slice(0, colon).trim()
  if (s.endsWith('?')) s = s.slice(0, -1)
  return s
}

function paramNamesOnly(params) {
  const names = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < params.length; i++) {
    const c = params[i]
    if (c === '<' || c === '(' || c === '{') depth++
    else if (c === '>' || c === ')' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      const n = stripParamName(cur)
      if (n) names.push(n)
      cur = ''
      continue
    }
    cur += c
  }
  const last = stripParamName(cur)
  if (last) names.push(last)
  return names.join(', ')
}

function toModuleFn(method) {
  let t = method.text
    .replace(/^  private async /, 'export async function ')
    .replace(/^  private /, 'export function ')
  t = t.replace(/^(export (?:async )?function \w+)\(/, '$1(ctx: TradeExecutorContext, ')
  t = t.replace(/\bthis\./g, 'ctx.')
  return t
}

function makeClassDelegate(method, mod) {
  const { name, params, isAsync, retType } = method
  const ret = retType ? `: ${retType}` : ''
  const awaitKw = isAsync ? 'await ' : ''
  const names = paramNamesOnly(params)
  const callArgs = names ? `this, ${names}` : 'this'
  const asyncKw = isAsync ? 'async ' : ''
  return `  ${asyncKw}${name}(${params})${ret} {\n    return ${awaitKw}${mod}.${name}(${callArgs})\n  }`
}

const modules = {
  brokerSymbolCache: [
    'prewarmSymbolsEnabled', 'prewarmBrokerCaches', 'sessionHeartbeatTick', 'symbolCacheKeepaliveTick',
    'reconnectCachedBrokers', 'markBrokerSessionDown', 'pingBrokerSession', 'ensureBrokerSession',
    'ensureBrokerSessionLiveFast', 'brokersWarmForLiveEntry', 'prewarmForDispatch', 'prewarmBrokersForLiveEntry',
    'getSymbolParams', 'refreshSymbolParams', 'getSymbolList', 'fetchSymbolList', 'resolveBrokerSymbolFromInventory',
    'resolveBrokerSymbolForLiveEntry', 'resolveBrokerSymbol',
  ],
  dispatch: [
    'shouldUseEntryFastPath', 'enqueueSignal', 'scheduleQueueDrain', 'dequeueQueuedSignal', 'drainSignalQueues',
    'logPipelineStage', 'logDispatchSkipped', 'logPipelineSummaryBackground', 'markSignalExecuted',
    'signalLiveDispatchAlreadyHandled', 'signalAlreadyHandled', 'signalTooOldForReplay', 'claimSignalExecution',
    'handleSignal', 'getChannelMeta', 'brokerEligibleForSignal',
  ],
  basketMerge: [
    'hasOpenTradeForSymbol', 'reconcileGhostBasketLegs', 'parentSignalIdChainContainsAnchor',
    'resolveBasketAnchorSignalIdForOpenTrades', 'manualDispatchAlreadyMaterialized',
    'cancelSignalEntryBrokerRowsForScope', 'cancelRangePendingLegsForScopes', 'persistRangePendingLegRows',
    'closeOppositeDirectionTrades', 'loadMergeSignalForLinking', 'resolveBasketMergeLinkContext',
    'tryParameterFollowUpMergeModifyOnly', 'syncMultiBasketLegTakeProfits', 'applyBasketSlTpRefresh',
    'tryMergeSignalIntoExistingOpenTrade',
  ],
  managementExecutor: [
    'logSendSkipped', 'skipMgmtSignal', 'applyManagement', 'applyCloseWorseEntriesInstruction',
  ],
}

const moduleImports = {
  brokerSymbolCache: `import type { TradeExecutorContext } from './context'
import {
  hasFxsocketConfigured,
  FxsocketBrokerClient,
  normalizeSymbolParams,
  type SymbolParams,
} from '../fxsocketClient'
import type { ManualSettings } from '../manualPlanner'
import { writeBrokerConnectionStatus } from '../brokerConnectionStatus'
import { applySymbolMapping, isMtUuid, parseSymbolToTradeList } from './helpers'
import {
  SESSION_PING_MIN_INTERVAL_MS,
  SYMBOL_CACHE_STALE_MS,
  SYMBOL_CACHE_TTL_MS,
  SYMBOL_LIST_TTL_MS,
  type BrokerRow,
  type SignalRow,
  type SymbolCacheEntry,
  type SymbolListCacheEntry,
} from './types'
`,
  dispatch: `import type { TradeExecutorContext } from './context'
import {
  dispatchPriorityForAction,
  isEntryAction,
  isManagementAction,
  parsedAction,
  signalMatchesExecutorMode,
} from '../tradeSignalActions'
import { workerConfig } from '../workerConfig'
import { channelMatchesBrokerSignal } from '../brokerChannelFilter'
import {
  isChannelManagementBlocked,
  normalizeChannelMessageFiltersMap,
} from '../channelMessageFilters'
import { shouldRouteAsBasketParameterRefresh } from '../multiTradeMerge'
import { SKIP_REASON_SIGNAL_ENTRY_REQUIRED } from '../manualPlanner'
import { parsePipelineTimestamps, pipelineSummaryPayload } from '../pipelineTimestamps'
import { buildTscopierCommentPrefix, resolveChannelLabelForComment, sanitizeChannelCommentSlug } from '../tradeComment'
import { isMtUuid, operationFor } from './helpers'
import {
  EXECUTION_LOG_ACTIONS_HANDLED,
  EXECUTOR_MAX_CONCURRENT_SIGNALS,
  EXECUTOR_REPLAY_MAX_AGE_MS,
  PARSED_STATUSES,
  telegramLiveTradeGateEnabled,
  type SignalRow,
} from './types'
import type { ChannelKeywords } from '../manualPlanner'
`,
  basketMerge: `${SHARED_IMPORTS}\nimport type { TradeExecutorContext } from './context'\n`,
  managementExecutor: `${SHARED_IMPORTS}\nimport type { TradeExecutorContext } from './context'\n`,
}

const extracted = []
const moduleBodies = {}
for (const [mod, names] of Object.entries(modules)) {
  const fns = []
  for (const name of names) {
    const m = extractMethod(name)
    if (!m) {
      console.error('MISSING', mod, name)
      continue
    }
    extracted.push(m)
    fns.push(toModuleFn(m))
  }
  moduleBodies[mod] = moduleImports[mod] + '\n' + fns.join('\n\n') + '\n'
  console.log('collected', mod, fns.length)
}

const sendOrder = extractMethod('sendOrder')
if (!sendOrder) throw new Error('sendOrder not found')

const sendBodyStart = findMethodBodyBrace(sendOrder.start)
if (sendBodyStart < 0) throw new Error('sendOrder body brace not found')
const sendInner = src.slice(sendBodyStart + 1, sendOrder.end - 1)
if (sendInner.includes('import { RealtimeChannel')) {
  throw new Error('sendOrder body slice looks wrong (contains file imports)')
}

for (const [mod, body] of Object.entries(moduleBodies)) {
  fs.writeFileSync(path.join(root, `${mod}.ts`), body)
}

// Replace sendOrder body with router (keep signature)
const sendHead = sendOrder.text.split('{')[0]
const routerBody = `  ${sendHead.trim().replace(/^  private async sendOrder/, 'private async sendOrder')} {
    const isManual = (broker.copier_mode ?? 'ai') === 'manual'
    const manual = (broker.manual_settings ?? {}) as import('../manualPlanner').ManualSettings
    if (isManual && manual.trade_style === 'multi') {
      return runRangeEntry(this, { signal, parsed, op, broker, channelKeywords, pipelineT0, sendOpts })
    }
    return runSingleEntry(this, { signal, parsed, op, broker, channelKeywords, pipelineT0, sendOpts })
  }`

// Sort replacements by position desc
extracted.sort((a, b) => b.start - a.start)
for (const m of extracted) {
  const mod = Object.entries(modules).find(([, ns]) => ns.includes(m.name))?.[0]
  if (!mod) continue
  src = src.slice(0, m.start) + makeClassDelegate(m, mod) + src.slice(m.end)
}
src = src.slice(0, sendOrder.start) + routerBody.replace(/^  private async sendOrder/, '  async sendOrder') + src.slice(sendOrder.end)

// Public fields for extracted modules
src = src.replace(/^  private brokersByUser /m, '  brokersByUser ')
src = src.replace(/^  private brokersById /m, '  brokersById ')
src = src.replace(/^  private inflight /m, '  inflight ')
src = src.replace(/^  private queuedIds /m, '  queuedIds ')
src = src.replace(/^  private highPriorityQueue/m, '  highPriorityQueue')
src = src.replace(/^  private normalPriorityQueue/m, '  normalPriorityQueue')
src = src.replace(/^  private queueDrainScheduled/m, '  queueDrainScheduled')
src = src.replace(/^  private queueDraining/m, '  queueDraining')
src = src.replace(/^  private symbolCache /m, '  symbolCache ')
src = src.replace(/^  private symbolListCache /m, '  symbolListCache ')
src = src.replace(/^  private channelMetaCache /m, '  channelMetaCache ')
src = src.replace(/^  private sessionPingAt /m, '  sessionPingAt ')
src = src.replace(/^  private sessionCheckInflight /m, '  sessionCheckInflight ')
src = src.replace(/^  private symbolListInflight /m, '  symbolListInflight ')
src = src.replace(/^  private symbolParamsInflight /m, '  symbolParamsInflight ')
src = src.replace(/^  private sessionOrderBlocked /m, '  sessionOrderBlocked ')
src = src.replace(/^  private brokerActivatedAt /m, '  brokerActivatedAt ')
src = src.replace(
  /constructor\(\n    private readonly supabase: SupabaseClient,\n    private readonly sessionManager\?: UserSessionManager,/,
  'constructor(\n    readonly supabase: SupabaseClient,\n    readonly sessionManager?: UserSessionManager,',
)
src = src.replace(/^  private apiFor\(/m, '  apiFor(')
src = src.replace(/^  private apiForUuid\(/m, '  apiForUuid(')

fs.writeFileSync(srcPath, src)

const sendFnBody = `export async function runSingleEntry(ctx: TradeExecutorContext, args: EntryArgs): Promise<SendOrderOutcome> {
  const { signal, parsed, op, broker, channelKeywords, pipelineT0, sendOpts } = args
${sendInner.replace(/^    /gm, '  ').replace(/\bthis\./g, 'ctx.')}
}`
const entryImports = `${SHARED_IMPORTS}
import type { TradeExecutorContext } from './context'
import type { SendOrderOutcome, SignalRow, ParsedSignal } from './types'

export type EntryArgs = {
  signal: SignalRow
  parsed: ParsedSignal
  op: MtOperation
  broker: import('./types').BrokerRow
  channelKeywords: ChannelKeywords | null
  pipelineT0?: number
  sendOpts?: { liveEntryFast?: boolean; commentPrefix?: string }
}

`
fs.writeFileSync(path.join(root, 'singleEntryExecutor.ts'), entryImports + sendFnBody + '\n')

const rangeStub = `${SHARED_IMPORTS}
import type { TradeExecutorContext } from './context'
import type { SendOrderOutcome } from './types'
import { runSingleEntry, type EntryArgs } from './singleEntryExecutor'

/** Manual multi / range ladder — delegates to single entry until range path is split further. */
export async function runRangeEntry(ctx: TradeExecutorContext, args: EntryArgs): Promise<SendOrderOutcome> {
  return runSingleEntry(ctx, args)
}
`
fs.writeFileSync(path.join(root, 'entryRouter.ts'), `export { runSingleEntry } from './singleEntryExecutor'\nexport { runRangeEntry } from './rangeTradeExecutor'\n`)
fs.writeFileSync(path.join(root, 'rangeTradeExecutor.ts'), rangeStub)

console.log('TradeExecutor patched, singleEntryExecutor lines:', sendFnBody.split('\n').length)
