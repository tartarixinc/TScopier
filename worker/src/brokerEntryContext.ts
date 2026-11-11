/**
 * Entry-path broker call context.
 *
 * Live entry Quotes / OpenedOrders used to share the global MTAPI background
 * gateway lane with monitors (auto-BE, reconcile, heartbeats). That made
 * `send_plan_ms` routinely 8–10s while OrderSend itself stayed ~1s.
 *
 * `runWithEntryBrokerReads` forces those reads onto the order lane for the
 * duration of prepare+send, and accumulates per-endpoint gateway wait vs HTTP
 * so `pipeline_summary` can attribute the gap.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { BrokerPriority } from './brokerGateway'

export type BrokerCallTimingTotals = {
  quote_count: number
  quote_gateway_wait_ms: number
  quote_http_ms: number
  opened_orders_count: number
  opened_orders_gateway_wait_ms: number
  opened_orders_http_ms: number
  account_summary_count: number
  account_summary_gateway_wait_ms: number
  account_summary_http_ms: number
  order_send_count: number
  order_send_gateway_wait_ms: number
  order_send_http_ms: number
  other_count: number
  other_gateway_wait_ms: number
  other_http_ms: number
}

type EntryBrokerContext = {
  readPriority: BrokerPriority
  timings: BrokerCallTimingTotals
}

const storage = new AsyncLocalStorage<EntryBrokerContext>()

function emptyTimings(): BrokerCallTimingTotals {
  return {
    quote_count: 0,
    quote_gateway_wait_ms: 0,
    quote_http_ms: 0,
    opened_orders_count: 0,
    opened_orders_gateway_wait_ms: 0,
    opened_orders_http_ms: 0,
    account_summary_count: 0,
    account_summary_gateway_wait_ms: 0,
    account_summary_http_ms: 0,
    order_send_count: 0,
    order_send_gateway_wait_ms: 0,
    order_send_http_ms: 0,
    other_count: 0,
    other_gateway_wait_ms: 0,
    other_http_ms: 0,
  }
}

export function runWithEntryBrokerReads<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({
    readPriority: 'order',
    timings: emptyTimings(),
  }, fn)
}

/** Optional override for management baskets that must not wait behind monitors. */
export function runWithPriorityBrokerReads<T>(
  readPriority: BrokerPriority,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = storage.getStore()
  return storage.run({
    readPriority,
    timings: parent?.timings ?? emptyTimings(),
  }, fn)
}

export function currentEntryReadPriority(): BrokerPriority | undefined {
  return storage.getStore()?.readPriority
}

export function recordBrokerCallTiming(args: {
  endpoint: string
  gatewayWaitMs: number
  httpMs: number
}): void {
  const ctx = storage.getStore()
  if (!ctx) return
  const wait = Math.max(0, Math.round(args.gatewayWaitMs))
  const http = Math.max(0, Math.round(args.httpMs))
  const ep = args.endpoint.toLowerCase()
  if (ep === 'quote' || ep === 'getquote') {
    ctx.timings.quote_count += 1
    ctx.timings.quote_gateway_wait_ms += wait
    ctx.timings.quote_http_ms += http
    return
  }
  if (ep === 'openedorders') {
    ctx.timings.opened_orders_count += 1
    ctx.timings.opened_orders_gateway_wait_ms += wait
    ctx.timings.opened_orders_http_ms += http
    return
  }
  if (ep === 'accountsummary') {
    ctx.timings.account_summary_count += 1
    ctx.timings.account_summary_gateway_wait_ms += wait
    ctx.timings.account_summary_http_ms += http
    return
  }
  if (ep === 'ordersendsafe' || ep === 'ordersend') {
    ctx.timings.order_send_count += 1
    ctx.timings.order_send_gateway_wait_ms += wait
    ctx.timings.order_send_http_ms += http
    return
  }
  ctx.timings.other_count += 1
  ctx.timings.other_gateway_wait_ms += wait
  ctx.timings.other_http_ms += http
}

/** Flat extras for `pipeline_summary` / structured logs. */
export function entryBrokerTimingExtras(): Record<string, number> | null {
  const timings = storage.getStore()?.timings
  if (!timings) return null
  const extras: Record<string, number> = {}
  for (const [key, value] of Object.entries(timings)) {
    if (typeof value === 'number' && value > 0) extras[key] = value
  }
  return Object.keys(extras).length > 0 ? extras : null
}

/** Survives past the ALS scope so `pipeline_summary` can include the split. */
const timingsBySignalId = new Map<string, Record<string, number>>()

export function stashEntryBrokerTimings(signalId: string): void {
  const extras = entryBrokerTimingExtras()
  if (!extras || !signalId) return
  const prev = timingsBySignalId.get(signalId)
  if (!prev) {
    timingsBySignalId.set(signalId, extras)
    return
  }
  const merged = { ...prev }
  for (const [key, value] of Object.entries(extras)) {
    merged[key] = (merged[key] ?? 0) + value
  }
  timingsBySignalId.set(signalId, merged)
}

export function takeEntryBrokerTimings(signalId: string): Record<string, number> | null {
  const extras = timingsBySignalId.get(signalId) ?? null
  if (extras) timingsBySignalId.delete(signalId)
  return extras
}
