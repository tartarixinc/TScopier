#!/usr/bin/env bash
# Code-preservation checks for every Martins (Planmoni) fix pulled into this branch.
# Purpose: fail loudly if any of the fix code is later removed or silently changed.
# Usage: bash docs/audit-2026-11-11/verify-martins-fixes.sh   (run from repo root)
set -u
cd "$(dirname "$0")/../.." || exit 2
pass=0; fail=0
must() { # must <label> <file> <pattern>
  if grep -qE -- "$3" "$2" 2>/dev/null; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL  $1  (missing /$3/ in $2)"; fi
}
mustnot() { # mustnot <label> <file-or-dir> <pattern>
  if grep -rqE -- "$3" "$2" 2>/dev/null; then fail=$((fail+1)); echo "FAIL  $1  (/$3/ reappeared in $2 — was deliberately removed)"; else pass=$((pass+1)); fi
}
exists() { if [ -f "$2" ] || [ -d "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL  $1  (missing file/dir: $2)"; fi }

# ---- Close path -------------------------------------------------------------
must "instant close (trusted ack)"            worker/src/managementClose.ts        'closeMarketPositionFast'
must "multi-leg empty-readback retries"       worker/src/managementClose.ts        'EMPTY_READBACK_MULTI_EXTRA_ATTEMPTS'
must "fast close used by force-close"         worker/src/forceCloseSignalTrades.ts 'closeMarketPositionFast'
must "straggler filtering on close-all"       worker/src/managementBrokerClose.ts  'filterSnapshotStragglerOrdersForClose'
must "close-all snapshot tickets helper"      worker/src/tradeExecutor/managementExecutor.ts 'preCloseTicketsBySession'

# ---- Duplicate / orphan guards ---------------------------------------------
must "near-duplicate orphan fold (impl)"      worker/src/managementScope.ts        'loadNearDuplicateOrphanTradesForClose'
must "near-duplicate orphan fold (wired)"     worker/src/tradeExecutor/managementExecutor.ts 'loadNearDuplicateOrphanTradesForClose'
must "opened-position dedupe (impl)"          worker/src/livePositionIdentity.ts   'dedupeOpenedMarketPositions'
must "opened-position dedupe (copy path)"     worker/src/copyShared/copyHelpers.ts 'dedupeOpenedMarketPositions'
must "in-flight duplicate send guard"         worker/src/tradeExecutor/TradeExecutor.ts 'skip duplicate in-flight sendOrder'
must "mgmt accept dedupe"                     worker/src/tradeExecutor/TradeExecutor.ts 'shouldSkipDuplicateMgmtAccept'

# ---- SL/TP freeze & modify safety -----------------------------------------
must "frozen stops comment (no fill restamp)" worker/src/virtualPendingMonitor.ts   'first-entry freeze'
mustnot "restamp-from-fill removed"           worker/src                          'restampBasketTargetsFromLegEntries'
must "manual settings extended (range sync)"  worker/src/rangeBasketTpSync.ts      'use_predefined_sl_pips'
must "adjust-SL preflight gate"               worker/src/channelStopApply.ts       'verifyOnBroker'
must "adjust-SL live-fast path"               worker/src/channelStopApply.ts       'liveFast'
must "one shared basket quote"                worker/src/basketSlTpReconcile.ts    'One shared quote for the whole basket'
must "merge ghost sweep skip (live fast)"     worker/src/tradeExecutor/basketMerge/mergeRouting.ts 'skipGhostReconcile'
must "merge summary counts as materialized"   worker/src/tradeExecutor/basketMerge/helpers.ts 'merge_modify_summary'
must "edited-signal revision waits inflight"  worker/src/tradeExecutor/TradeExecutor.ts 'waitForSignalInflightClear'
must "claim-lost SL/TP refresh"               worker/src/tradeExecutor/TradeExecutor.ts 'SL/TP only'
must "message_revision mgmt fast path"        worker/src/tradeExecutor/dispatch.ts 'message_revision'
must "empty-TP range fallback"                worker/src/manualPlanning/planMultiManualOrders.ts 'multi_trade_fallback_empty_tps'

# ---- Latency lanes / warm caches ------------------------------------------
exists "entry-critical lane module"           worker/src/brokerEntryContext.ts
must "entry-critical lane wired (provider)"   worker/src/mtapiProvider.ts          'brokerEntryContext'
must "send concurrency env"                   worker/src/mtapiProvider.ts          'MT_SEND_OP_CONCURRENCY'
must "modify concurrency env"                 worker/src/mtapiProvider.ts          'MT_MODIFY_OP_CONCURRENCY'
must "close concurrency env"                  worker/src/mtapiProvider.ts          'MT_CLOSE_OP_CONCURRENCY'
must "throttle retry env"                     worker/src/mtapiProvider.ts          'MTAPI_ORDER_THROTTLE_RETRY'
must "per-account order rps"                  worker/src/brokerGateway.ts          'MTAPI_ORDER_PER_ACCOUNT_RPS'
must "symbol params peek cache"               worker/src/tradeExecutor/brokerSymbolCache.ts 'peekCachedSymbolParams'
must "listener parallel pre-parse"            worker/src/userListener.ts           'parentSignalId'
must "real-time work-wake resubscribe"        worker/src/monitorWorkWake.ts        'consecutiveFailures'
must "push requires accepted ack"             worker/src/tradeSignalPush.ts        'accepted'
exists "internal token module"                worker/src/internalToken.ts

# ---- Ingestion sources (TV / WhatsApp) ------------------------------------
exists "TV always-on ingest module"           worker/src/tradingViewIngest.ts
must "TV ingest route"                        worker/src/httpServer.ts             'webhooks/tradingview'
must "TV stops eligibility"                   worker/src/signalExecutionEligibility.ts 'tradingViewEntryStopsSatisfied'
must "ensureSignalRow source kind"            worker/src/ensureSignalRow.ts        'source_kind'
must "WhatsApp honours PORT"                  worker/src/whatsappListener.ts       'process\.env\.PORT'
must "UI prefers live channel kind"           src/lib/signalSourceMark.ts          'live'

# ---- Toasts / docs / migrations -------------------------------------------
must "toast announcement logic"               src/lib/copierLogToast.ts            'shouldAnnounceCopierLogToast'
must "toast logic wired in component"         src/components/dashboard/CopierLogToasts.tsx 'shouldAnnounceCopierLogToast'
exists "migration signals.source_kind"        supabase/migrations/20261111081000_signals_source_kind.sql
exists "migration signals.source_display_name" supabase/migrations/20261111091500_signals_source_display_name.sql
exists "migration TV alert config"            supabase/migrations/20261112080000_tradingview_webhook_alert_config.sql

echo "----------------------------------------"
echo "code-preservation: $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
