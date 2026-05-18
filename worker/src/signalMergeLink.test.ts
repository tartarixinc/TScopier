import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
  MERGE_SIGNAL_LINK_WINDOW_MS,
  MERGE_SIGNAL_PRE_OPEN_SKEW_MS,
  computeBasketMergeLinkContext,
  computeThreadLinksAnchor,
  implicitBundleTimeOk,
  isMergeFollowUpLinked,
  isWithinMergeSignalTimeWindow,
  mergeSignalTimeDeltaMs,
  parentSignalLinksAnchor,
} from './signalMergeLink'

test('isWithinMergeSignalTimeWindow: inside forward window', () => {
  assert.equal(isWithinMergeSignalTimeWindow(0), true)
  assert.equal(isWithinMergeSignalTimeWindow(MERGE_SIGNAL_LINK_WINDOW_MS), true)
  assert.equal(isWithinMergeSignalTimeWindow(MERGE_SIGNAL_LINK_WINDOW_MS + 1), false)
})

test('isWithinMergeSignalTimeWindow: pre-open skew', () => {
  assert.equal(isWithinMergeSignalTimeWindow(-MERGE_SIGNAL_PRE_OPEN_SKEW_MS), true)
  assert.equal(isWithinMergeSignalTimeWindow(-MERGE_SIGNAL_PRE_OPEN_SKEW_MS - 1), false)
})

test('implicitBundleTimeOk: inside tight forward window', () => {
  assert.equal(implicitBundleTimeOk(0, MERGE_IMPLICIT_CHANNEL_BUNDLE_MS), true)
  assert.equal(implicitBundleTimeOk(MERGE_IMPLICIT_CHANNEL_BUNDLE_MS, MERGE_IMPLICIT_CHANNEL_BUNDLE_MS), true)
  assert.equal(
    implicitBundleTimeOk(MERGE_IMPLICIT_CHANNEL_BUNDLE_MS + 1, MERGE_IMPLICIT_CHANNEL_BUNDLE_MS),
    false,
  )
})

test('implicitBundleTimeOk: pre-open skew matches long window helper', () => {
  assert.equal(implicitBundleTimeOk(-MERGE_SIGNAL_PRE_OPEN_SKEW_MS, MERGE_IMPLICIT_CHANNEL_BUNDLE_MS), true)
  assert.equal(
    implicitBundleTimeOk(-MERGE_SIGNAL_PRE_OPEN_SKEW_MS - 1, MERGE_IMPLICIT_CHANNEL_BUNDLE_MS),
    false,
  )
})

test('isMergeFollowUpLinked: reply alone allows merge (no thread, no window)', () => {
  assert.equal(
    isMergeFollowUpLinked({
      replyOk: true,
      withinWindow: false,
      threadLinksAnchor: false,
      implicitBundleWithinTightWindow: false,
      implicitSameChannelBundle: false,
    }),
    true,
  )
})

test('isMergeFollowUpLinked: time window alone is NOT enough (fresh broadcast)', () => {
  assert.equal(
    isMergeFollowUpLinked({
      replyOk: false,
      withinWindow: true,
      threadLinksAnchor: false,
      implicitBundleWithinTightWindow: false,
      implicitSameChannelBundle: false,
    }),
    false,
  )
})

test('isMergeFollowUpLinked: time window + thread link allows merge (direct parent)', () => {
  assert.equal(
    isMergeFollowUpLinked({
      replyOk: false,
      withinWindow: true,
      threadLinksAnchor: true,
      implicitBundleWithinTightWindow: false,
      implicitSameChannelBundle: false,
    }),
    true,
  )
})

test('isMergeFollowUpLinked: wrong thread blocks window merge', () => {
  assert.equal(
    isMergeFollowUpLinked({
      replyOk: false,
      withinWindow: true,
      threadLinksAnchor: false,
      implicitBundleWithinTightWindow: false,
      implicitSameChannelBundle: false,
    }),
    false,
  )
})

test('isMergeFollowUpLinked: implicit same-channel bundle without long window', () => {
  assert.equal(
    isMergeFollowUpLinked({
      replyOk: false,
      withinWindow: false,
      threadLinksAnchor: false,
      implicitBundleWithinTightWindow: true,
      implicitSameChannelBundle: true,
    }),
    true,
  )
})

test('isMergeFollowUpLinked: implicit bundle blocked outside tight window', () => {
  assert.equal(
    isMergeFollowUpLinked({
      replyOk: false,
      withinWindow: false,
      threadLinksAnchor: false,
      implicitBundleWithinTightWindow: false,
      implicitSameChannelBundle: true,
    }),
    false,
  )
})

test('isMergeFollowUpLinked: same-channel SL/TP parameter refresh within long window', () => {
  assert.equal(
    isMergeFollowUpLinked({
      replyOk: false,
      withinWindow: true,
      threadLinksAnchor: false,
      implicitBundleWithinTightWindow: false,
      implicitSameChannelBundle: false,
      parameterRefreshSameChannel: true,
    }),
    true,
  )
})

test('computeBasketMergeLinkContext: SL/TP same-channel refresh without entry anchor', () => {
  const now = Date.now()
  const ctx = computeBasketMergeLinkContext({
    signalCreatedAtMs: now,
    newestTradeOpenedAtMs: now - 60_000,
    replyToTelegramId: '',
    anchorTelegramMessageId: '100',
    mergeChannelId: 'ch-1',
    anchorChannelId: 'ch-1',
    parentSignalId: null,
    anchorSignalId: 'anchor-1',
    hasSl: true,
    hasTp: true,
    ancestorChainContainsAnchor: false,
  })
  assert.equal(ctx.parameterRefreshSameChannel, true)
  assert.equal(ctx.isLinked, true)
})

test('isMergeFollowUpLinked: parameter refresh blocked outside long window', () => {
  assert.equal(
    isMergeFollowUpLinked({
      replyOk: false,
      withinWindow: false,
      threadLinksAnchor: false,
      implicitBundleWithinTightWindow: false,
      implicitSameChannelBundle: false,
      parameterRefreshSameChannel: true,
    }),
    false,
  )
})

test('computeThreadLinksAnchor: parent alone (no reply) links thread', () => {
  assert.equal(
    computeThreadLinksAnchor({
      parentLinksAnchor: true,
      hasReplyToTelegram: false,
      ancestorChainContainsAnchor: false,
    }),
    true,
  )
})

test('computeThreadLinksAnchor: multi-hop reply thread (no direct parent)', () => {
  assert.equal(
    computeThreadLinksAnchor({
      parentLinksAnchor: false,
      hasReplyToTelegram: true,
      ancestorChainContainsAnchor: true,
    }),
    true,
  )
})

test('computeThreadLinksAnchor: reply but ancestor misses anchor → false', () => {
  assert.equal(
    computeThreadLinksAnchor({
      parentLinksAnchor: false,
      hasReplyToTelegram: true,
      ancestorChainContainsAnchor: false,
    }),
    false,
  )
})

test('computeThreadLinksAnchor: ancestor true but no Telegram reply → false (fresh post)', () => {
  assert.equal(
    computeThreadLinksAnchor({
      parentLinksAnchor: false,
      hasReplyToTelegram: false,
      ancestorChainContainsAnchor: true,
    }),
    false,
  )
})

test('mergeSignalTimeDeltaMs: signal after trade open → positive dt', () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0)
  const t1 = t0 + 60_000
  assert.equal(mergeSignalTimeDeltaMs({ signalCreatedAtMs: t1, newestTradeOpenedAtMs: t0 }), 60_000)
})

test('merge policy: multi-hop reply + window → merge allowed', () => {
  const anchor = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const thread = computeThreadLinksAnchor({
    parentLinksAnchor: parentSignalLinksAnchor('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', anchor),
    hasReplyToTelegram: true,
    ancestorChainContainsAnchor: true,
  })
  assert.equal(thread, true)
  assert.equal(
    isMergeFollowUpLinked({
      replyOk: false,
      withinWindow: true,
      threadLinksAnchor: thread,
      implicitBundleWithinTightWindow: false,
      implicitSameChannelBundle: false,
    }),
    true,
  )
})

test('parentSignalLinksAnchor: empty vs anchor', () => {
  assert.equal(parentSignalLinksAnchor(null, 'x'), false)
  assert.equal(parentSignalLinksAnchor('', 'x'), false)
  assert.equal(parentSignalLinksAnchor('x', 'x'), true)
})
