import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildDesiredLegTargets } from './v2ReconcileMonitor'
import type { FxOpenOrder } from './fxContract'
import type { BasketOpenLeg } from '../basketSlTpReconcile'

function leg(over: Partial<BasketOpenLeg> = {}): BasketOpenLeg {
  return { id: 'leg', signal_id: 'sig', metaapi_order_id: '100', opened_at: '', lot_size: 0.05, sl: 4065, tp: 4089, entry_price: 4078, direction: 'buy', symbol: 'XAUUSD', auto_be_applied_at: null, ...over }
}
function open(ticket: number, over: Partial<FxOpenOrder> = {}): FxOpenOrder {
  return { ticket, symbol: 'XAUUSD', operation: 'Buy', isBuy: true, volume: 0.05, openPrice: 4078, stopLoss: 4065, takeProfit: 4089, comment: '', magic: 770077, isPending: false, ...over }
}

describe('buildDesiredLegTargets', () => {
  it('applies the effective basket SL to every leg present at the broker', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100' }), leg({ id: 'l2', metaapi_order_id: '101' })],
      snapshot: [open(100), open(101)],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4089],
      isBuy: true,
    })
    assert.equal(t.length, 2)
    assert.ok(t.every(x => x.stoploss === 4090))
  })

  it('keeps the existing broker TP (never repaints a present TP)', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100' })],
      snapshot: [open(100, { takeProfit: 4089 })],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4095],
      isBuy: true,
    })
    assert.equal(t[0]!.takeProfit, 4089, 'present TP preserved, not replaced by ladder')
  })

  it('fills a leg naked everywhere (no DB TP, no broker TP) with the deepest ladder TP', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', tp: null })],
      snapshot: [open(100, { takeProfit: null })],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4095],
      isBuy: true,
    })
    assert.equal(t[0]!.takeProfit, 4095, 'deepest (farthest) TP for a buy')
  })

  it('prefers the intended DB TP over a drifted broker TP (self-heals a collapsed distribution)', () => {
    // The basket distributed TP1=4083 to this leg, but a racing tick previously
    // pushed the deepest TP (4095) onto the broker. The reconciler must restore
    // the intended distributed TP, not keep the broker's collapsed deepest.
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', tp: 4083 })],
      snapshot: [open(100, { takeProfit: 4095 })],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4089, 4095],
      isBuy: true,
    })
    assert.equal(t[0]!.takeProfit, 4083, 'intended DB TP wins over drifted broker TP')
  })

  it('uses the intended DB TP for a leg still naked on the broker (race with in-flight distribution)', () => {
    // mgmt modify wrote the distributed TP to the DB but the broker snapshot was
    // captured before the broker modify landed. Without this the tick would fill
    // the deepest TP and collapse the distribution.
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', tp: 4089 })],
      snapshot: [open(100, { takeProfit: null })],
      effectiveSl: 4090,
      effectiveTpLevels: [4083, 4089, 4095],
      isBuy: true,
    })
    assert.equal(t[0]!.takeProfit, 4089, 'naked broker leg gets the intended DB TP, not the deepest')
  })

  it('enforces SL on a naked leg (broker SL missing) using the effective SL', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', sl: 0 })],
      snapshot: [open(100, { stopLoss: null })],
      effectiveSl: 3970,
      effectiveTpLevels: [4005, 4010, 4015],
      isBuy: true,
    })
    assert.equal(t[0]!.stoploss, 3970, 'naked broker leg gets the effective SL')
  })

  it('preserves a more-protective per-leg auto-breakeven (never loosens a BE leg)', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100', sl: 4078, auto_be_applied_at: '2026-06-24T11:00:00Z' })],
      snapshot: [open(100, { stopLoss: 4078 })],
      effectiveSl: 4065, // looser than the BE 4078 for a buy
      effectiveTpLevels: [4089],
      isBuy: true,
    })
    assert.equal(t[0]!.stoploss, 4078, 'BE SL kept; not loosened to 4065')
  })

  it('keeps each leg its own breakeven SL — never collapses a multi-entry basket onto one SL', () => {
    // Two layered entries breakevened at different entry-relative SLs. The basket-level
    // effectiveSl equals the deepest leg BE (4078); it must NOT be forced onto leg 2.
    const t = buildDesiredLegTargets({
      legs: [
        leg({ id: 'l1', metaapi_order_id: '100', sl: 4078, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
        leg({ id: 'l2', metaapi_order_id: '101', sl: 4072, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
      ],
      snapshot: [open(100, { stopLoss: 4078 }), open(101, { stopLoss: 4072 })],
      effectiveSl: 4078,
      effectiveTpLevels: [4089],
      isBuy: true,
      effectiveSource: 'channel_memory',
    })
    const byTicket = new Map(t.map(x => [x.ticket, x.stoploss]))
    assert.equal(byTicket.get(100), 4078, 'leg 1 keeps its own breakeven')
    assert.equal(byTicket.get(101), 4072, 'leg 2 keeps its own breakeven, not collapsed to 4078')
  })

  it('lets an explicit newer instruction (basket_target) override per-leg breakeven on all legs', () => {
    const t = buildDesiredLegTargets({
      legs: [
        leg({ id: 'l1', metaapi_order_id: '100', sl: 4078, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
        leg({ id: 'l2', metaapi_order_id: '101', sl: 4072, auto_be_applied_at: '2026-06-24T11:00:00Z' }),
      ],
      snapshot: [open(100, { stopLoss: 4078 }), open(101, { stopLoss: 4072 })],
      effectiveSl: 4090,
      effectiveTpLevels: [4089],
      isBuy: true,
      effectiveSource: 'basket_target',
    })
    assert.ok(t.every(x => x.stoploss === 4090), 'explicit Adjust applies to every leg (latest instruction wins)')
  })

  it('skips legs not present at the broker (left for closedTickets)', () => {
    const t = buildDesiredLegTargets({
      legs: [leg({ metaapi_order_id: '100' }), leg({ id: 'l2', metaapi_order_id: '999' })],
      snapshot: [open(100)],
      effectiveSl: 4090,
      effectiveTpLevels: [],
      isBuy: true,
    })
    assert.equal(t.length, 1)
    assert.equal(t[0]!.ticket, 100)
  })
})
