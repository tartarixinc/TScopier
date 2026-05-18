/**
 * Merge-into-open-basket eligibility for manual `add_new_trades_to_existing`.
 *
 * Kept in a pure module so worker tests lock the policy: unrelated "fresh"
 * channel posts must not merge solely because an open trade exists within a
 * time window (regression guard, May 2026).
 */

/** Max span after newest open leg `opened_at` for parent-linked follow-ups. */
export const MERGE_SIGNAL_LINK_WINDOW_MS = 4 * 60 * 60_000

/** Allow clock skew / ordering where the signal row is stamped slightly before fill. */
export const MERGE_SIGNAL_PRE_OPEN_SKEW_MS = 120_000

/**
 * Tight window for same-channel "entry + parameters" posts with **no** Telegram
 * reply thread — avoids treating unrelated alerts hours apart as one basket.
 */
export const MERGE_IMPLICIT_CHANNEL_BUNDLE_MS = 10 * 60_000

export function mergeSignalTimeDeltaMs(args: {
  signalCreatedAtMs: number
  newestTradeOpenedAtMs: number
}): number {
  return args.signalCreatedAtMs - args.newestTradeOpenedAtMs
}

export function isWithinMergeSignalTimeWindow(dtMs: number): boolean {
  return dtMs >= -MERGE_SIGNAL_PRE_OPEN_SKEW_MS && dtMs <= MERGE_SIGNAL_LINK_WINDOW_MS
}

/** Same skew as {@link isWithinMergeSignalTimeWindow}, capped forward by `tightWindowMs`. */
export function implicitBundleTimeOk(dtMs: number, tightWindowMs: number): boolean {
  return dtMs >= -MERGE_SIGNAL_PRE_OPEN_SKEW_MS && dtMs <= tightWindowMs
}

export function parentSignalLinksAnchor(
  parentSignalId: string | null | undefined,
  anchorSignalId: string,
): boolean {
  return String(parentSignalId ?? '') === anchorSignalId
}

/**
 * True when the merge row is linked to the open basket by parent pointers or
 * by a Telegram reply thread whose `parent_signal_id` chain reaches the anchor
 * (see TradeExecutor.parentSignalIdChainContainsAnchor).
 */
export function computeThreadLinksAnchor(args: {
  parentLinksAnchor: boolean
  hasReplyToTelegram: boolean
  ancestorChainContainsAnchor: boolean
}): boolean {
  return args.parentLinksAnchor || (args.hasReplyToTelegram && args.ancestorChainContainsAnchor)
}

/**
 * True when this follow-up may refresh SL/TP on the anchor basket:
 * - Direct Telegram reply to the anchor entry (`replyOk`), or
 * - Long window + thread/parent link (`withinWindow && threadLinksAnchor`), or
 * - Tight window + same-channel implicit bundle (caller sets `implicitSameChannelBundle`), or
 * - Long window + same channel + SL/TP/entry parameter post (typical “entry + SL + TP”
 *   follow-up that is not a Telegram reply).
 */
export function isMergeFollowUpLinked(args: {
  replyOk: boolean
  withinWindow: boolean
  threadLinksAnchor: boolean
  implicitBundleWithinTightWindow: boolean
  implicitSameChannelBundle: boolean
  parameterRefreshSameChannel?: boolean
}): boolean {
  const implicitPath =
    args.implicitBundleWithinTightWindow && args.implicitSameChannelBundle
  return (
    args.replyOk ||
    (args.withinWindow && args.threadLinksAnchor) ||
    implicitPath ||
    (args.withinWindow && args.parameterRefreshSameChannel === true)
  )
}

export type BasketMergeLinkInput = {
  signalCreatedAtMs: number
  newestTradeOpenedAtMs: number
  replyToTelegramId: string
  anchorTelegramMessageId: string
  mergeChannelId: string | null
  anchorChannelId: string | null
  parentSignalId: string | null
  anchorSignalId: string
  hasSl: boolean
  hasTp: boolean
  ancestorChainContainsAnchor: boolean
}

export type BasketMergeLinkContext = {
  replyOk: boolean
  withinWindow: boolean
  threadLinksAnchor: boolean
  implicitBundleWithinTightWindow: boolean
  implicitSameChannelBundle: boolean
  parameterRefreshSameChannel: boolean
  isLinked: boolean
  dtMs: number
  parentLinksAnchor: boolean
}

/** Shared merge-link flags for entry merge and SL/TP parameter refresh paths. */
export function computeBasketMergeLinkContext(input: BasketMergeLinkInput): BasketMergeLinkContext {
  const dtMs = mergeSignalTimeDeltaMs({
    signalCreatedAtMs: input.signalCreatedAtMs,
    newestTradeOpenedAtMs: input.newestTradeOpenedAtMs,
  })
  const withinWindow = isWithinMergeSignalTimeWindow(dtMs)
  const replyOk = Boolean(
    input.replyToTelegramId
    && input.anchorTelegramMessageId
    && input.replyToTelegramId === input.anchorTelegramMessageId,
  )
  const parentLinksAnchor = parentSignalLinksAnchor(input.parentSignalId, input.anchorSignalId)
  const hasReplyToTelegram = Boolean(input.replyToTelegramId)
  const threadLinksAnchor = computeThreadLinksAnchor({
    parentLinksAnchor,
    hasReplyToTelegram,
    ancestorChainContainsAnchor: input.ancestorChainContainsAnchor,
  })
  const mergeCh = String(input.mergeChannelId ?? '').trim() || null
  const anchorCh = String(input.anchorChannelId ?? '').trim() || null
  const implicitBundleWithinTightWindow = implicitBundleTimeOk(dtMs, MERGE_IMPLICIT_CHANNEL_BUNDLE_MS)
  const implicitSameChannelBundle = Boolean(
    mergeCh && anchorCh && mergeCh === anchorCh && !replyOk && !threadLinksAnchor,
  )
  const parameterRefreshSameChannel = Boolean(
    mergeCh
    && anchorCh
    && mergeCh === anchorCh
    && withinWindow
    && !replyOk
    && !threadLinksAnchor
    && (input.hasSl || input.hasTp),
  )
  const flags = {
    replyOk,
    withinWindow,
    threadLinksAnchor,
    implicitBundleWithinTightWindow,
    implicitSameChannelBundle,
    parameterRefreshSameChannel,
  }
  return {
    ...flags,
    parentLinksAnchor,
    dtMs,
    isLinked: isMergeFollowUpLinked(flags),
  }
}
