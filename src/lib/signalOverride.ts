import type { Json, Signal } from '../types/database'
import {
  MANAGEMENT_COPIER_ACTIONS,
  parsedSignalAction,
  resolveRecentChannelEntrySignalId,
  symbolForCopierLog,
  type CopierSymbolContext,
} from './copierLogDisplay'

export type SignalUserOverride = {
  sl?: number | null
  tp?: number[]
  entry?: number | null
  updated_at?: string
}

const ENTRY_ACTIONS = new Set(['buy', 'sell'])

/** Management actions that adjust displayed SL/TP on the anchor entry row. */
const SL_TP_MGMT_ACTIONS = new Set(['modify', 'breakeven', 'partial_breakeven'])

export type SignalBatchRow = Pick<
  Signal,
  | 'id'
  | 'channel_id'
  | 'created_at'
  | 'parsed_data'
  | 'raw_message'
  | 'parent_signal_id'
  | 'user_override'
  | 'reply_to_message_id'
  | 'is_modification'
>

export type BatchSignalIndex = {
  batchSignals: ReadonlyArray<SignalBatchRow>
  batchById: Map<string, SignalBatchRow>
  replyParentBySignalId: ReadonlyMap<string, string>
  symbolContext: CopierSymbolContext
  anchorCache: Map<string, string | null>
  entrySymbolById: Map<string, string>
  entriesByGroupKey: Map<string, SignalBatchRow[]>
  parentSignalIdByRowId: Map<string, string | null>
}

export type SignalDisplayContext = {
  batchSignals: ReadonlyArray<SignalBatchRow>
  symbolContext?: CopierSymbolContext
  replyParentBySignalId?: ReadonlyMap<string, string>
  batchIndex?: BatchSignalIndex
}

export function buildBatchSignalIndex(ctx: SignalDisplayContext): BatchSignalIndex {
  const batchSignals = ctx.batchSignals
  const symbolContext = ctx.symbolContext ?? { lookup: new Map(), replyParentBySignalId: new Map() }
  const replyParentBySignalId = ctx.replyParentBySignalId ?? symbolContext.replyParentBySignalId
  const batchById = new Map(batchSignals.map(row => [row.id, row]))
  const entrySymbolById = new Map<string, string>()
  const entriesByGroupKey = new Map<string, SignalBatchRow[]>()
  const parentSignalIdByRowId = new Map<string, string | null>()

  for (const row of batchSignals) {
    parentSignalIdByRowId.set(row.id, row.parent_signal_id ?? null)
    if (!ENTRY_ACTIONS.has(parsedSignalAction(row.parsed_data)) || !row.channel_id) continue
    const sym = symbolForCopierLog(row, symbolContext, batchSignals as SignalBatchRow[])
    entrySymbolById.set(row.id, sym)
    if (!sym || sym === '—') continue
    const key = `${row.channel_id}:${sym}`
    const list = entriesByGroupKey.get(key) ?? []
    list.push(row)
    entriesByGroupKey.set(key, list)
  }

  for (const list of entriesByGroupKey.values()) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
  }

  return {
    batchSignals,
    batchById,
    replyParentBySignalId,
    symbolContext,
    anchorCache: new Map(),
    entrySymbolById,
    entriesByGroupKey,
    parentSignalIdByRowId,
  }
}

export function enrichSignalDisplayContext(ctx: SignalDisplayContext): SignalDisplayContext {
  return ctx.batchIndex ? ctx : { ...ctx, batchIndex: buildBatchSignalIndex(ctx) }
}

function positiveLevel(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeTpLevels(tp: unknown): number[] {
  if (!Array.isArray(tp)) return []
  return tp.filter((t): t is number => positiveLevel(t) != null) as number[]
}

export function parseUserOverride(raw: unknown): SignalUserOverride | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const sl = row.sl === null || row.sl === undefined ? undefined : positiveLevel(row.sl)
  const tp = row.tp === undefined ? undefined : normalizeTpLevels(row.tp)
  const entry = row.entry === null || row.entry === undefined ? undefined : positiveLevel(row.entry)
  const updated_at = typeof row.updated_at === 'string' ? row.updated_at : undefined
  if (sl === undefined && tp === undefined && entry === undefined && !updated_at) return null
  return { sl, tp, entry, updated_at }
}

export function mergeSignalUserOverride<T extends Record<string, unknown>>(
  parsed: T | null | undefined,
  override: SignalUserOverride | null | undefined,
  opts?: { overlay?: boolean },
): T {
  const base = (parsed && typeof parsed === 'object' ? { ...parsed } : {}) as T & {
    sl?: unknown
    tp?: unknown
  }
  if (!override) return base as T

  const hasSl = positiveLevel(base.sl) != null
  const hasTp = normalizeTpLevels(base.tp).length > 0
  const overlay = opts?.overlay === true

  if (overlay || override.sl != null) {
    if (override.sl != null) base.sl = override.sl
    else if (override.sl === null && overlay) base.sl = null
  } else if (!hasSl && override.sl != null) {
    base.sl = override.sl
  }

  if (overlay || (override.tp != null && override.tp.length > 0)) {
    if (override.tp != null && override.tp.length > 0) base.tp = [...override.tp]
    else if (override.tp != null && overlay) base.tp = []
  } else if (!hasTp && override.tp != null && override.tp.length > 0) {
    base.tp = [...override.tp]
  }

  if (override.entry != null || (override.entry === null && overlay)) {
    ;(base as Record<string, unknown>).entry = override.entry
  }

  return base as T
}

export function effectiveParsedData(
  signal: { parsed_data?: Json | null; user_override?: Json | null },
): Record<string, unknown> {
  const parsed = (signal.parsed_data ?? {}) as Record<string, unknown>
  const override = parseUserOverride(signal.user_override)
  return mergeSignalUserOverride(parsed, override, { overlay: true })
}

function slFromParsed(parsed: Record<string, unknown>): number | null {
  return positiveLevel(parsed.sl ?? parsed.stoploss ?? parsed.stop_loss)
}

function tpFromParsed(parsed: Record<string, unknown>): number[] {
  const raw = parsed.tp ?? parsed.takeprofit ?? parsed.take_profit ?? parsed.take_profits
  return normalizeTpLevels(raw)
}

function applySlTpLevelsFromParsed(
  parsed: Record<string, unknown>,
  sourceParsed: unknown,
): Record<string, unknown> {
  const next = { ...parsed }
  const source = (sourceParsed ?? {}) as Record<string, unknown>
  const sl = slFromParsed(source)
  if (sl != null) next.sl = sl
  const tp = tpFromParsed(source)
  if (tp.length > 0) next.tp = tp
  return next
}

function applyMgmtParsedToEntry(
  parsed: Record<string, unknown>,
  mgmtParsed: unknown,
): Record<string, unknown> {
  const action = parsedSignalAction(mgmtParsed)
  if (
    action === 'modify'
    || action === 'breakeven'
    || action === 'partial_breakeven'
    || action === 'buy'
    || action === 'sell'
  ) {
    return applySlTpLevelsFromParsed(parsed, mgmtParsed)
  }
  return parsed
}

function findEntryInParentChain(
  signalId: string,
  batchById: ReadonlyMap<string, SignalBatchRow>,
  replyParentBySignalId?: ReadonlyMap<string, string>,
): SignalBatchRow | null {
  let current: string | null | undefined = signalId
  for (let depth = 0; current && depth < 24; depth++) {
    const row = batchById.get(current)
    if (!row) return null
    const action = parsedSignalAction(row.parsed_data)
    if (ENTRY_ACTIONS.has(action)) return row
    current = row.parent_signal_id?.trim()
      ?? replyParentBySignalId?.get(row.id)?.trim()
      ?? null
  }
  return null
}

function hasIntermediateEntryForSymbol(
  entry: SignalBatchRow,
  mgmt: SignalBatchRow,
  batchSignals: ReadonlyArray<SignalBatchRow>,
  ctx?: SignalDisplayContext,
): boolean {
  const index = ctx?.batchIndex
  const entryMs = Date.parse(entry.created_at)
  const mgmtMs = Date.parse(mgmt.created_at)
  if (!Number.isFinite(entryMs) || !Number.isFinite(mgmtMs)) return false

  const sym = index?.entrySymbolById.get(entry.id)
    ?? symbolForCopierLog(
      entry,
      ctx?.symbolContext ?? { lookup: new Map(), replyParentBySignalId: new Map() },
      batchSignals as SignalBatchRow[],
    )
  if (!sym || sym === '—' || !entry.channel_id) return false

  const candidates = index?.entriesByGroupKey.get(`${entry.channel_id}:${sym}`)
  if (candidates) {
    for (const row of candidates) {
      if (row.id === entry.id) continue
      const rowMs = Date.parse(row.created_at)
      if (!Number.isFinite(rowMs) || rowMs <= entryMs || rowMs >= mgmtMs) continue
      return true
    }
    return false
  }

  const symbolContext = ctx?.symbolContext ?? { lookup: new Map(), replyParentBySignalId: new Map() }
  for (const row of batchSignals) {
    if (row.id === entry.id) continue
    if (!ENTRY_ACTIONS.has(parsedSignalAction(row.parsed_data))) continue
    const rowMs = Date.parse(row.created_at)
    if (!Number.isFinite(rowMs) || rowMs <= entryMs || rowMs >= mgmtMs) continue
    const rowSym = symbolForCopierLog(row, symbolContext, batchSignals as SignalBatchRow[])
    if (rowSym === sym) return true
  }
  return false
}

function resolveManagementAnchorEntryIdWithIndex(
  mgmt: SignalBatchRow,
  index: BatchSignalIndex,
): string | null {
  const cached = index.anchorCache.get(mgmt.id)
  if (cached !== undefined) return cached

  const action = parsedSignalAction(mgmt.parsed_data)
  if (!MANAGEMENT_COPIER_ACTIONS.has(action)) {
    index.anchorCache.set(mgmt.id, null)
    return null
  }

  const parentId = mgmt.parent_signal_id?.trim()
    ?? index.replyParentBySignalId.get(mgmt.id)?.trim()
  if (parentId) {
    const entry = findEntryInParentChain(parentId, index.batchById, index.replyParentBySignalId)
    if (entry) {
      index.anchorCache.set(mgmt.id, entry.id)
      return entry.id
    }
  }

  const batchSignals = index.batchSignals as SignalBatchRow[]
  const entryId = resolveRecentChannelEntrySignalId(mgmt, batchSignals)
  if (!entryId) {
    index.anchorCache.set(mgmt.id, null)
    return null
  }

  const mgmtSymbol = symbolForCopierLog(mgmt, index.symbolContext, batchSignals)
  const entry = index.batchById.get(entryId)
  if (!entry) {
    index.anchorCache.set(mgmt.id, null)
    return null
  }
  const entrySymbol = index.entrySymbolById.get(entry.id)
    ?? symbolForCopierLog(entry, index.symbolContext, batchSignals)
  const result = mgmtSymbol !== '—' && entrySymbol !== '—' && mgmtSymbol !== entrySymbol
    ? null
    : entryId
  index.anchorCache.set(mgmt.id, result)
  return result
}

export function resolveManagementAnchorEntryId(
  mgmt: SignalBatchRow,
  batchSignals: ReadonlyArray<SignalBatchRow>,
  ctx?: SignalDisplayContext,
): string | null {
  if (ctx?.batchIndex) {
    return resolveManagementAnchorEntryIdWithIndex(mgmt, ctx.batchIndex)
  }

  const action = parsedSignalAction(mgmt.parsed_data)
  if (!MANAGEMENT_COPIER_ACTIONS.has(action)) return null

  const batchById = new Map(batchSignals.map(row => [row.id, row]))
  const replyParentBySignalId = ctx?.replyParentBySignalId ?? ctx?.symbolContext?.replyParentBySignalId

  const parentId = mgmt.parent_signal_id?.trim()
    ?? replyParentBySignalId?.get(mgmt.id)?.trim()
  if (parentId) {
    const entry = findEntryInParentChain(parentId, batchById, replyParentBySignalId)
    if (entry) return entry.id
  }

  const batchArray = batchSignals as SignalBatchRow[]
  const entryId = resolveRecentChannelEntrySignalId(mgmt, batchArray)
  if (!entryId) return null

  const symbolContext = ctx?.symbolContext ?? { lookup: new Map(), replyParentBySignalId: new Map() }
  const mgmtSymbol = symbolForCopierLog(mgmt, symbolContext, batchArray)
  const entry = batchById.get(entryId)
  if (!entry) return null
  const entrySymbol = symbolForCopierLog(entry, symbolContext, batchArray)
  if (mgmtSymbol !== '—' && entrySymbol !== '—' && mgmtSymbol !== entrySymbol) return null
  return entryId
}

export function collectMgmtUpdatesForEntry(
  entry: SignalBatchRow,
  batchSignals: ReadonlyArray<SignalBatchRow>,
  ctx?: SignalDisplayContext,
  alsoAnchorToIds: ReadonlySet<string> = new Set(),
): SignalBatchRow[] {
  if (!ENTRY_ACTIONS.has(parsedSignalAction(entry.parsed_data))) return []

  return batchSignals
    .filter(row => {
      if (row.id === entry.id) return false
      const action = parsedSignalAction(row.parsed_data)
      if (!SL_TP_MGMT_ACTIONS.has(action)) return false
      const anchorId = resolveManagementAnchorEntryId(row, batchSignals, ctx)
      if (anchorId !== entry.id && !(anchorId && alsoAnchorToIds.has(anchorId))) return false
      return !hasIntermediateEntryForSymbol(entry, row, batchSignals, ctx)
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
}

function collectFoldEventsForEntry(
  entry: SignalBatchRow,
  batchSignals: ReadonlyArray<SignalBatchRow>,
  ctx: SignalDisplayContext | undefined,
  absorbedEntryUpdates: ReadonlyArray<SignalBatchRow>,
): SignalBatchRow[] {
  const absorbedIds = new Set(absorbedEntryUpdates.map(row => row.id))
  const events: SignalBatchRow[] = [...absorbedEntryUpdates]

  for (const row of batchSignals) {
    if (row.id === entry.id || absorbedIds.has(row.id)) continue
    const action = parsedSignalAction(row.parsed_data)
    if (!SL_TP_MGMT_ACTIONS.has(action)) continue
    const anchorId = resolveManagementAnchorEntryId(row, batchSignals, ctx)
    if (anchorId !== entry.id && !(anchorId && absorbedIds.has(anchorId))) continue
    if (hasIntermediateEntryForSymbol(entry, row, batchSignals, ctx)) continue
    events.push(row)
  }

  const seen = new Set<string>()
  return events
    .filter(row => {
      if (seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
}

export function foldMgmtUpdatesIntoParsed(
  entry: SignalBatchRow,
  batchSignals: ReadonlyArray<SignalBatchRow>,
  ctx?: SignalDisplayContext,
  absorbedEntryUpdates: ReadonlyArray<SignalBatchRow> = [],
): Record<string, unknown> {
  let parsed = { ...((entry.parsed_data ?? {}) as Record<string, unknown>) }

  for (const update of collectFoldEventsForEntry(entry, batchSignals, ctx, absorbedEntryUpdates)) {
    parsed = applyMgmtParsedToEntry(parsed, update.parsed_data)
  }

  return parsed
}

/** Channel entry + folded modify/breakeven updates + user override (Manage Signals display). */
export function effectiveDisplayParsedData(
  signal: SignalBatchRow,
  ctx?: SignalDisplayContext,
  absorbedEntryUpdates: ReadonlyArray<SignalBatchRow> = [],
): Record<string, unknown> {
  const base = ctx?.batchSignals?.length && ENTRY_ACTIONS.has(parsedSignalAction(signal.parsed_data))
    ? foldMgmtUpdatesIntoParsed(signal, ctx.batchSignals, ctx, absorbedEntryUpdates)
    : ((signal.parsed_data ?? {}) as Record<string, unknown>)
  const override = parseUserOverride(signal.user_override)
  return mergeSignalUserOverride(base, override, { overlay: true })
}

export type ConsolidatedEntrySignal = {
  signal: Signal
  lastActivityAt: string
  absorbedEntryUpdates: SignalBatchRow[]
}

function consolidationGroupKey(
  entry: Signal,
  batchSignals: ReadonlyArray<SignalBatchRow>,
  ctx?: SignalDisplayContext,
): string | null {
  if (!entry.channel_id) return null
  const symbol = ctx?.batchIndex?.entrySymbolById.get(entry.id)
    ?? symbolForCopierLog(
      entry,
      ctx?.symbolContext ?? { lookup: new Map(), replyParentBySignalId: new Map() },
      batchSignals as SignalBatchRow[],
    )
  if (!symbol || symbol === '—') return null
  return `${entry.channel_id}:${symbol}`
}

function shouldAbsorbFollowUpEntry(
  anchor: Signal,
  followUp: Signal,
  openSignalIds: ReadonlySet<string>,
): boolean {
  if (!openSignalIds.has(anchor.id)) return false
  if (openSignalIds.has(followUp.id)) return false
  return true
}

function lastActivityForConsolidatedRow(
  anchor: Signal,
  absorbedEntryUpdates: ReadonlyArray<SignalBatchRow>,
  batchSignals: ReadonlyArray<SignalBatchRow>,
  ctx?: SignalDisplayContext,
): string {
  const events = collectFoldEventsForEntry(anchor as SignalBatchRow, batchSignals, ctx, absorbedEntryUpdates)
  const candidates = [anchor.created_at, ...events.map(row => row.created_at)]
  return candidates.reduce((latest, at) => (
    Date.parse(at) > Date.parse(latest) ? at : latest
  ))
}

export function buildConsolidatedEntrySignals(
  signals: Signal[],
  ctx?: SignalDisplayContext,
  openSignalIds: ReadonlySet<string> = new Set(),
): ConsolidatedEntrySignal[] {
  const batch = ctx?.batchSignals ?? signals
  const enrichedCtx = ctx
    ? enrichSignalDisplayContext({ ...ctx, batchSignals: batch })
    : enrichSignalDisplayContext({ batchSignals: batch })
  const entries = signals.filter(isEditableEntrySignal)

  const byGroup = new Map<string, Signal[]>()
  const ungrouped: Signal[] = []

  for (const entry of entries) {
    const key = consolidationGroupKey(entry, batch, enrichedCtx)
    if (!key) {
      ungrouped.push(entry)
      continue
    }
    const list = byGroup.get(key) ?? []
    list.push(entry)
    byGroup.set(key, list)
  }

  const consolidated: ConsolidatedEntrySignal[] = []

  const flushCycle = (anchor: Signal, absorbed: SignalBatchRow[]) => {
    consolidated.push({
      signal: anchor,
      absorbedEntryUpdates: absorbed,
      lastActivityAt: lastActivityForConsolidatedRow(anchor, absorbed, batch, enrichedCtx),
    })
  }

  for (const groupEntries of byGroup.values()) {
    const sorted = [...groupEntries].sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    )

    let anchor: Signal | null = null
    let absorbed: SignalBatchRow[] = []

    for (const entry of sorted) {
      if (!anchor) {
        anchor = entry
        continue
      }

      if (shouldAbsorbFollowUpEntry(anchor, entry, openSignalIds)) {
        absorbed.push(entry as SignalBatchRow)
        continue
      }

      flushCycle(anchor, absorbed)
      anchor = entry
      absorbed = []
    }

    if (anchor) flushCycle(anchor, absorbed)
  }

  for (const entry of ungrouped) {
    consolidated.push({
      signal: entry,
      absorbedEntryUpdates: [],
      lastActivityAt: lastActivityForConsolidatedRow(entry, [], batch, enrichedCtx),
    })
  }

  return consolidated.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
}

export function isHiddenManagementSignal(
  signal: Pick<Signal, 'parsed_data' | 'channel_id'>,
): boolean {
  if (!signal.channel_id) return true
  const action = parsedSignalAction(signal.parsed_data)
  return MANAGEMENT_COPIER_ACTIONS.has(action)
}

export function isEditableEntrySignal(
  signal: { parsed_data?: Json | null; channel_id?: string | null },
): boolean {
  if (!signal.channel_id) return false
  const action = parsedSignalAction(signal.parsed_data)
  return ENTRY_ACTIONS.has(action)
}

export function buildOpenSignalIdSet(
  rows: ReadonlyArray<{ signal_id?: string | null }>,
): Set<string> {
  const out = new Set<string>()
  for (const row of rows) {
    const id = row.signal_id?.trim()
    if (id) out.add(id)
  }
  return out
}

export type SignalOpenStatusContext = {
  batchSignals?: ReadonlyArray<
    Pick<Signal, 'id' | 'channel_id' | 'created_at' | 'parsed_data' | 'parent_signal_id' | 'raw_message'>
  >
  replyParentBySignalId?: ReadonlyMap<string, string>
  parentSignalIdByRowId?: ReadonlyMap<string, string | null>
}

function buildParentSignalIdMap(
  ctx?: SignalOpenStatusContext,
): Map<string, string | null> {
  if (ctx?.parentSignalIdByRowId) {
    return new Map(ctx.parentSignalIdByRowId)
  }
  const map = new Map<string, string | null>()
  for (const row of ctx?.batchSignals ?? []) {
    map.set(row.id, row.parent_signal_id ?? null)
  }
  return map
}

function isOpenViaParentChain(
  signal: Pick<Signal, 'id' | 'parent_signal_id'>,
  openSignalIds: ReadonlySet<string>,
  ctx?: SignalOpenStatusContext,
): boolean {
  const parentMap = ctx?.parentSignalIdByRowId ?? buildParentSignalIdMap(ctx)
  let current = signal.parent_signal_id?.trim()
    ?? ctx?.replyParentBySignalId?.get(signal.id)?.trim()
    ?? null
  for (let depth = 0; current && depth < 24; depth++) {
    if (openSignalIds.has(current)) return true
    current = parentMap.get(current)?.trim() ?? null
  }
  return false
}

export function resolveSignalOpenStatus(
  signal: Pick<
    Signal,
    'id' | 'channel_id' | 'created_at' | 'parsed_data' | 'parent_signal_id' | 'raw_message'
  >,
  openSignalIds: ReadonlySet<string>,
  ctx?: SignalOpenStatusContext,
): 'open' | 'closed' {
  if (openSignalIds.has(signal.id)) return 'open'
  if (isOpenViaParentChain(signal, openSignalIds, ctx)) return 'open'

  const action = parsedSignalAction(signal.parsed_data)
  if (MANAGEMENT_COPIER_ACTIONS.has(action) && ctx?.batchSignals?.length) {
    const entryId = resolveRecentChannelEntrySignalId(signal, ctx.batchSignals as SignalBatchRow[])
    if (entryId && openSignalIds.has(entryId)) return 'open'
  }

  return 'closed'
}

export function validateOverrideLevels(args: {
  sl: number | null
  tpLevels: number[]
}): boolean {
  const { sl, tpLevels } = args
  if (sl !== null && !(sl > 0)) return false
  if (tpLevels.some(n => !(n > 0))) return false
  return sl !== null || tpLevels.length > 0
}
