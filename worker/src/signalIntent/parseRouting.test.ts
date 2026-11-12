import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CHANNEL_KEYWORDS } from '../parseSignal'
import { deterministicQualifiesForFastPath } from './universalSignalParser'
import { routeStageThreeResult, shouldReconcileSignal } from './parseRouting'
import { tradeIntentToChannelParsedSignal } from './tradeIntentAdapter'
import type { TradeIntent } from './tradeIntent'
import type { ParseChannelMessageResult, ChannelParsedSignal } from '../parseSignal'
import type { UniversalParseResult } from './universalSignalParser'

function detResult(overrides: Partial<ChannelParsedSignal> = {}): ParseChannelMessageResult {
  return {
    status: 'parsed',
    skip_reason: null,
    parsed: {
      action: 'sell',
      symbol: 'XAUUSD',
      entry_price: 4276,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: [4256],
      lot_size: null,
      confidence: 0.93,
      raw_instruction: 'XAUUSD SELL 4276 TP 4256',
      ...overrides,
    },
  }
}

function stageTwo(
  kind: TradeIntent['kind'],
  overrides: Partial<TradeIntent> = {},
  extra: { source?: UniversalParseResult['source']; skipReason?: string | null; rawMessage?: string } = {},
): UniversalParseResult {
  const rawMessage = extra.rawMessage ?? 'XAUUSD SELL 4276 TP 4256'
  const intent: TradeIntent = {
    kind,
    side: kind === 'entry' ? 'SELL' : null,
    symbol: 'XAUUSD',
    entry: kind === 'entry' ? [4276] : [],
    sl: null,
    tp: kind === 'entry' ? [4256] : [],
    sl_unit: 'price',
    tp_unit: 'price',
    flags: {},
    confidence: 0.9,
    ...overrides,
  }
  return {
    parseResult: {
      parsed: tradeIntentToChannelParsedSignal(intent, rawMessage),
      status: kind === 'entry' ? 'parsed' : 'skipped',
      skip_reason: extra.skipReason ?? null,
    },
    intent,
    source: extra.source ?? 'openai',
    skip_reason: extra.skipReason ?? null,
  }
}

describe('deterministicQualifiesForFastPath', () => {
  it('accepts high-confidence eligible structured entry', () => {
    const msg = `GOLD BUY NOW
Entry 2650
SL 2640
TP 2660`
    const det = {
      status: 'parsed' as const,
      skip_reason: null,
      parsed: {
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: 2650,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: 2640,
        tp: [2660],
        lot_size: null,
        confidence: 0.99,
        raw_instruction: msg,
      },
    }
    assert.equal(
      deterministicQualifiesForFastPath(det, msg, DEFAULT_CHANNEL_KEYWORDS),
      true,
    )
  })

  it('rejects low-confidence deterministic parse', () => {
    const msg = 'maybe gold'
    const det = {
      status: 'parsed' as const,
      skip_reason: null,
      parsed: {
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: 2650,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: null,
        tp: [],
        lot_size: null,
        confidence: 0.5,
        raw_instruction: msg,
      },
    }
    assert.equal(
      deterministicQualifiesForFastPath(det, msg, DEFAULT_CHANNEL_KEYWORDS),
      false,
    )
  })

  it('fast-lanes management actions below entry FASTPATH_CONFIDENCE (0.92)', () => {
    const msg = 'Close all trades now'
    const det = {
      status: 'parsed' as const,
      skip_reason: null,
      parsed: {
        action: 'close',
        symbol: null,
        entry_price: null,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: null,
        tp: [],
        lot_size: null,
        confidence: 0.92,
        raw_instruction: msg,
      },
    }
    assert.equal(
      deterministicQualifiesForFastPath(det, msg, DEFAULT_CHANNEL_KEYWORDS),
      true,
    )
  })

  it('rejects a high-confidence parse that missed a labeled entry (Fix C)', () => {
    const msg = `BUY XAUUSD
AREA: 4358
SL: 4348
TP: 4370`
    const det = {
      status: 'parsed' as const,
      skip_reason: null,
      parsed: {
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: null,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: 4348,
        tp: [4370],
        lot_size: null,
        confidence: 0.99,
        raw_instruction: msg,
      },
    }
    assert.equal(
      deterministicQualifiesForFastPath(det, msg, DEFAULT_CHANNEL_KEYWORDS),
      false,
    )
  })

  it('still fast-lanes a high-confidence market entry with no entry label (Fix C)', () => {
    const msg = 'GOLD BUY NOW SL 2640 TP 2660'
    const det = {
      status: 'parsed' as const,
      skip_reason: null,
      parsed: {
        action: 'buy',
        symbol: 'XAUUSD',
        entry_price: null,
        entry_zone_low: null,
        entry_zone_high: null,
        sl: 2640,
        tp: [2660],
        lot_size: null,
        confidence: 0.99,
        raw_instruction: msg,
      },
    }
    assert.equal(
      deterministicQualifiesForFastPath(det, msg, DEFAULT_CHANNEL_KEYWORDS),
      true,
    )
  })

  it('still fast-lanes market text with incidental from/area prose (Fix C)', () => {
    for (const msg of [
      'GOLD BUY NOW SL 2640 TP 2660, target 200 pips from 2640',
      'GOLD BUY NOW SL 2640 TP 2660, support area 4350',
      'GOLD BUY NOW SL 2640 TP 2660, wait for a good entry',
    ]) {
      const det = {
        status: 'parsed' as const,
        skip_reason: null,
        parsed: {
          action: 'buy',
          symbol: 'XAUUSD',
          entry_price: null,
          entry_zone_low: null,
          entry_zone_high: null,
          sl: 2640,
          tp: [2660],
          lot_size: null,
          confidence: 0.99,
          raw_instruction: msg,
        },
      }
      assert.equal(
        deterministicQualifiesForFastPath(det, msg, DEFAULT_CHANNEL_KEYWORDS),
        true,
        `expected fast-lane for: ${msg}`,
      )
    }
  })
})

describe('shouldReconcileSignal', () => {
  const skippedDet = {
    status: 'skipped' as const,
    skip_reason: 'no_match',
    parsed: {
      action: 'ignore',
      symbol: null,
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: null,
      tp: [],
      lot_size: null,
      confidence: 0,
      raw_instruction: 'XAUUSD SELL 4276 TP 4256',
    },
  }

  it('reconciles when stage 2 is uncertain', () => {
    assert.equal(shouldReconcileSignal(skippedDet, stageTwo('uncertain')), true)
  })

  it('reconciles when the hallucination guard rejects stage 2 prices', () => {
    const uni = stageTwo('entry', { sl: 4281 }, { skipReason: 'intent_validation_failed:invented_sl' })
    assert.equal(shouldReconcileSignal(skippedDet, uni), true)
  })

  it('reconciles when stage 2 entry is missing a side', () => {
    const uni = stageTwo('entry', { side: null }, { skipReason: 'entry_missing_side' })
    assert.equal(shouldReconcileSignal(skippedDet, uni), true)
  })

  it('reconciles when deterministic wants a trade but stage 2 says ignore', () => {
    assert.equal(shouldReconcileSignal(detResult(), stageTwo('ignore')), true)
  })

  it('trusts stage 2 when it recovers a trade the deterministic parser skipped', () => {
    assert.equal(shouldReconcileSignal(skippedDet, stageTwo('entry')), false)
  })

  it('trusts stage 2 when it disagrees with the deterministic parser on values', () => {
    const uni = stageTwo('entry', { sl: 4280 })
    assert.equal(shouldReconcileSignal(detResult(), uni), false)
  })

  it('reconciles when stage 2 turns a deterministic modification into an entry', () => {
    assert.equal(shouldReconcileSignal(detResult({ action: 'modify' }), stageTwo('entry')), true)
  })

  it('reconciles when rules read close but stage 2 says cancel_pending (2026-11-11 incident shape)', () => {
    const uni = stageTwo('cancel_pending', { confidence: 0.5 }, { rawMessage: 'Close all trades now' })
    assert.equal(shouldReconcileSignal(detResult({ action: 'close' }), uni), true)
  })

  it('reconciles when rules skipped but stage 2 says cancel_pending (BUY LIMITS shape)', () => {
    const uni = stageTwo('cancel_pending', { confidence: 0.9 }, {
      rawMessage: 'BUY LIMITS GOLD @ 4050/4045 AREA\nTP 4053\nSL 4040',
    })
    assert.equal(shouldReconcileSignal(skippedDet, uni), true)
  })

  it('does not reconcile a confident cancel both sides agree on', () => {
    const uni = stageTwo('cancel_pending', { confidence: 0.9 })
    assert.equal(shouldReconcileSignal(detResult({ action: 'delete_pendings' }), uni), false)
  })

  it('reconciles when both sides read cancel but stage 2 is unsure', () => {
    const uni = stageTwo('cancel_pending', { confidence: 0.5 })
    assert.equal(shouldReconcileSignal(detResult({ action: 'delete_pendings' }), uni), true)
  })

  it('reconciles when stage 2 flips the entry side', () => {
    const uni = stageTwo('entry', { side: 'BUY' })
    assert.equal(shouldReconcileSignal(detResult(), uni), true)
  })

  it('reconciles a low-confidence executable answer even when the rules agree', () => {
    const uni = stageTwo('entry', { confidence: 0.5 })
    assert.equal(shouldReconcileSignal(skippedDet, uni), true)
  })

  it('does not reconcile confident same-kind management answers', () => {
    const uni = stageTwo('modify', { confidence: 0.9 })
    assert.equal(shouldReconcileSignal(detResult({ action: 'modify' }), uni), false)
  })

  it('does not reconcile when deterministic and stage 2 agree exactly', () => {
    const uni = stageTwo('entry', { sl: null, tp: [4256] })
    assert.equal(shouldReconcileSignal(detResult(), uni), false)
  })

  it('reconciles when stage 2 blocks a deterministic modification', () => {
    assert.equal(shouldReconcileSignal(detResult({ action: 'modify' }), stageTwo('ignore')), true)
  })

  it('does not reconcile when both skip as non-trade', () => {
    assert.equal(shouldReconcileSignal(skippedDet, stageTwo('commentary')), false)
  })

  it('does not reconcile when stage 2 is unavailable', () => {
    const uni = stageTwo('ignore', {}, { source: 'unavailable', skipReason: 'universal_parse_unavailable' })
    assert.equal(shouldReconcileSignal(skippedDet, uni), false)
  })
})

describe('routeStageThreeResult uncertain gating', () => {
  const prev = process.env.HUMAN_REVIEW_ESCALATION_ENABLED
  after(() => {
    if (prev != null) process.env.HUMAN_REVIEW_ESCALATION_ENABLED = prev
    else delete process.env.HUMAN_REVIEW_ESCALATION_ENABLED
  })

  // det is a confident deterministic PARSED entry while the reconciler still
  // says uncertain — the shape where falling through would execute the trade.
  const reconciledUncertain = () =>
    stageTwo('uncertain', {}, { skipReason: 'AI classified as non-actionable' })

  it('holds the skipped result and never executes when escalation is off (default)', () => {
    delete process.env.HUMAN_REVIEW_ESCALATION_ENABLED
    const reconciled = reconciledUncertain()
    const det = detResult()
    const result = routeStageThreeResult(reconciled, det, {
      universal: reconciled,
      path: 'stage3',
    })
    assert.equal(result.parseResult, reconciled.parseResult)
    assert.equal(result.parseResult.status, 'skipped')
    assert.equal(result.aiMeta?.reviewRequired, undefined)
    assert.equal(result.aiMeta?.intent, 'uncertain')
  })

  it('asks for approval only while escalation is active', () => {
    process.env.HUMAN_REVIEW_ESCALATION_ENABLED = 'true'
    const reconciled = reconciledUncertain()
    const result = routeStageThreeResult(reconciled, detResult(), {
      universal: reconciled,
      path: 'stage3',
    })
    assert.equal(result.parseResult, reconciled.parseResult)
    assert.equal(result.parseResult.status, 'skipped')
    assert.equal(result.aiMeta?.reviewRequired, true)
  })
})
