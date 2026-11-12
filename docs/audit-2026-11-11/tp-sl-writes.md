# TP/SL instability audit — worker + supabase — 2026-11-11

Scope: tree at HEAD `9915b992` (pre-pull; includes `e8def833`, `468da314`, `dd1c12f9`).

## (a) SL/TP writers that issue broker OrderModify for open positions

| # | Writer | Broker call | Trigger / cadence | Writes |
|---|---|---|---|---|
| 1 | entry send (strips then OrderSend) | `orderLegExecution.ts:225-247` | signal dispatch | broker SL/TP + trades.sl/tp |
| 2 | postFillFollowUp | `postFillFollowUp.ts:276` | per fill (void after `orderLegExecution.ts:1130`) | modify (both sides) + trades |
| 3 | basketModFollowUp | `basketModFollowUp.ts:177` | new virtual leg fills | modify (both keys, may be 0) + trades |
| 4 | channelStopApply (live "Adjust SL/TP") | `channelStopApply.ts:1086` | Telegram modify → `managementExecutor.ts:1987` (default on) | modify + trades + channel_active_trade_params + basket_sl_tp_targets + maybe reconcile job |
| 5 | managementExecutor breakeven/partial_breakeven | `managementExecutor.ts:1559` | Telegram breakeven | modify + trades + auto_be_applied_at + optional job (`:1870`) |
| 6 | managementModifyBaskets (legacy) | `managementModifyBaskets.ts:108` | only when `MGMT_USE_CHANNEL_STOP_APPLY=false` | modify + trades |
| 7 | applySignalOverride (Manage Signals) | `applySignalOverride.ts:380` | UI → edge → `/internal/apply-signal-override` | modify + trades + basket targets + clears auto_be stamp + reapplies pendings |
| 8 | autoManagementMonitor (auto BE) | `autoManagementMonitor.ts:605-609` | **400 ms** loop; open rows with auto_be_mode set & stamp null | modify `stoploss=beSl, takeprofit=modifyTp (may be 0)` + trades.sl/tp + stamp |
| 9 | trailingStopMonitor | `trailingStopMonitor.ts:233-237` | **400 ms** loop; trail_peak_price set | modify `takeprofit=trade.tp ?? 0` + trades.sl + trail fields |
| 10 | basketSlTpReconcileMonitor → runBasketLegModifies | `basketSlTpReconcile.ts:733` | jobs 5 s + **drift sweep 90 s** | modify for EVERY leg (DB-only skip disabled `:354`) + trades.sl/tp/cwe |
| 11 | rangeBasketTpSync | `rangeBasketTpSync.ts:1061` | fills/merges/rebalance (loops 200 ms / 2 s) | modify + trades + range_pending_legs |
| 12 | brokerPendingStopsSync | `brokerPendingStopsSync.ts:42` | naked-pending heal | OrderModify on resting pendings |
| 13 | brokerPendingFillStops | `brokerPendingFillStops.ts:124` | naked fill | modify + trades (+maybe stamp) |
| 14 | virtualPendingMonitor post-naked | `virtualPendingMonitor.ts:1410` | 200 ms loop | modify + trades |
| 15–16 | diagnostics CLIs | `rebalanceOpenBaskets.ts:319-323` (stoploss may be **undefined → omitted**), `pushSignalStopsToBroker.ts:178` | manual | modify + trades |
| 17 | mirrorCopyMonitor | `mirrorCopyMonitor.ts:813-815` | 20 s reconcile | modify; either side **null → omitted** |
| 18 | socialCopyMonitor | `socialCopyMonitor.ts:603` | 10 s reconcile | modify; either side **null → omitted** |
| 19 | engine/reconciler (v2, fxsocket only) | `engine/reconciler.ts:106,114` | **4 s** opt-in | **one-sided diff payloads + SL-only retry** — pre-`e8def833` bug unfixed |

Non-writers: managementClose (close-only), partialTpMonitor (OrderClose only), tradeBrokerDriftMonitor (read-only + repairs trades.status), openTradeReconcileMonitor (closes rows), channelSignalProjector (no stop writes), rangePendingLadderSync / channelActiveTradeParams reapply (DB-only), deletePendingsManagement.ts (**implementation does not exist** — only a test; logic in managementExecutor.ts:535-664 + tradesPendingCancel.ts), brokerPendingFillTpRedistribute (**file does not exist** — only a test).

## (b) Concrete conflict scenarios

**B1 — Trailing ↔ drift-sweep ping-pong (HIGH).** Desired-state resolution has NO trailing awareness (`grep trail` over basketEffectiveStops/basketReconcileTargets/channelStopApply = zero) while auto-BE IS protected (`basketEffectiveStops.ts:338-349 autoBeNewerThanTarget`). Sequence: adjust writes target 4100 → trail moves broker SL to 4115 + patches trades.sl → drift sweep (≤90 s) sees 4115 vs 4100, `explicitChannelTargets` bypasses never-loosen guard (`basketSlTpReconcile.ts:636`) → pushes 4100 back → trail re-applies within 400 ms (`trailingStop.ts:114-128` only moves forward). **SL flips ~every 90 s for the trade's life.**

**B2 — Auto-BE ↔ channel modify permanent BE revert (HIGH).** `channelStopApply.resolveTargetSlForLeg` (`:633-678`, default `slFrom:'parsed'` `:958`) never reads `auto_be_applied_at` (grep = none). Concurrent modify reads `keepSl = positiveNum(tr.sl)` before BE landed, writes signal-level SL back, stamp stays → BE never re-fires (work-set filter) and drift sees no drift → **breakeven lost forever.**

**B3 — SL-only retry still clears TP (MEDIUM-HIGH).** `orderModifySafe.ts:141` sends `{stoploss}` only → MTAPI clears TP to 0 (`docs/mtapi-conformance-sanitized.md:266`). TP-carrying retry (`:194`, from e8def833) restores normally, but window exists; if all TP candidates fail → returns `ok:true tpApplied:false`; channelStopApply logs `status:'success' tp_deferred:true` (`:1193-1212`) with `fullySynced` true → **no reconcile job** (`:1254-1258`). (applySignalOverride/postFillFollowUp throw instead — e8def833 covered those.)

**B4 — Broker TP never verified by v1 reconcile (HIGH, structural).** `basketLegsOutOfSyncOnBroker` reads SL only (`basketReconcileTargets.ts:369-399`, only when `target.stoploss > 0`); `readBrokerOrderTakeProfit` consumers: manualBrokerOverrideNotification + copyHelpers only. channelStopApply verify reads SL only, **off by default** (`MGMT_VERIFY_AFTER_MODIFY ?? 'false'`, `parallelPool.ts:23`), and skips entirely when DB matches (`:1024-1039`). → any path leaving trades.tp intact while broker TP = 0 is **invisible forever**.

**B5 — auto-BE/trailing send explicit `takeprofit: 0` (MEDIUM).** `autoManagementMonitor.ts:529-552` (`tpSanitize = brokerTp ?? 0`; tp_hit branch sets 0 at `:544-552`), `trailingStopMonitor.ts:228-230`. mtapi `:462` and fxsocket `:1241` forward 0 (only skip null) → clears the side. Trailing doesn't patch trades.tp → permanent divergence hidden by B4.

**B6 — auto_be `tp_hit` omission undone by sweep (MEDIUM).** `shouldOmitBrokerTpForAutoBeTpHit` (`autoManagement.ts:217-242`) sends entry without broker TP on purpose; reconcile records no "TP intentionally omitted" → sweep re-applies ladder TP → trade can close at TP1 — defeating the setting.

**B7 — `loadOpenBasketLegs` omits `cwe_close_price` (HIGH).** Select list `basketSlTpReconcile.ts:1254` lacks the column (contrast `rangeBasketTpSync.ts:787`), but `runBasketLegModifies` always writes it (`:792-797 → :805`) → within ≤90 s of a CWE basket opening, marker nulled + undesigned TP assigned; drift drives `nImmCwe: 0` so no protection.

**B8 — stale `channel_active_trade_params` without recency guard (MEDIUM).** `postFillFollowUp.ts:154-159` lacks `channelParamsPredateBasket` check (basketModFollowUp `:337-346` and basketEffectiveStops `:399-400` have it); `resolveTargetSlForLeg.tryChannel()` (`:649-658`) also unguarded.

**B9 — read-modify-write races, no per-trade/basket mutex (HIGH).** Only: account semaphore (mtapi 1 / fxsocket 3), non-exclusive `brokerWriteAuthority` (non-unique index, `20260929130000:47,103-114`), per-job CAS (single job row), provider serialize() (3 providers only), `markBasketReconcileDone` no status guard (`basketSlTpReconcile.ts:1231-1243`). On fxSocket up to 3 writers interleave OrderModify on the same ticket (B1/B2 sequences; `upsertBasketReconcileJob` resets attempts/status unconditionally `:1180-1188`).

## (c) Provider coverage — one-sided/blanking modify protection

| Provider | Omitted side | Explicit 0 | Carries counterpart? |
|---|---|---|---|
| **mtapi** (`mtapiProvider.ts:455-468`) | **bridge clears to 0** | forwarded → clears | No — callers must carry both |
| **fxsocket** (`fxsocketClient.ts:1238-1248`) | undocumented; 0 clears on MT4/MT5 | clears | No |
| **ctrader** (`:651-658`) | leaves alone | **cannot clear** (only sets >0) | No but API ignores omission (provider-dependent vs auto-BE tp_hit) |
| **matchtrader** (`:883-913`) | fills from live position row | 'remove' | **Yes — self-protecting** |
| **dxtrade** (`:883-948`) | leaves alone / returns current | 'remove' | **Yes** (SL first) |
| **tradelocker** (`:820-842`) | leaves alone | 'remove' | **Yes** |
| **binance/bybit/kucoin** | leaves alone | clear | **Yes** |
| **fx v2 engine/fxClient** (`:336-343`) | omitted; 0 forwarded | clears | No |
| **engine/reconciler (v2)** | **one-sided diff payloads + SL-only retry — pre-e8def833 bug unfixed** | | No |

Call sites still sending one-sided/zero payloads:
`orderModifySafe.ts:141` (SL-only retry), `autoManagementMonitor.ts:605-609` (tp may be 0), `trailingStopMonitor.ts:233-237` (tp may be 0), `basketModFollowUp.ts:177-181` (either may be 0), `diagnostics/rebalanceOpenBaskets.ts:319-323` (omitted when null), `mirrorCopyMonitor.ts:813-815` + `socialCopyMonitor.ts:603` (null omitted → clears other side on mtapi/fxsocket), `engine/reconciler.ts:106,114`, `channelStopApply.ts:1059-1060` (conditional on >0 — SL instruction on leg with trades.tp null sends SL-only).

## (d) Churn / loop risks

- **D1** drift sweep re-enqueues with `attempts:0` (`:1180-1188`) → 48-attempt cap & no-progress cap are per-job, not per-condition; structurally-valid-but-unapplicable targets (min-distance vs market) loop forever.
- **D2** `skipAlreadySynced` no-op (`:354`, "DB-only skip removed (naked-fill bug)") → every reconcile/range pass modifies EVERY leg; `rangeBasketTpSync.ts:1058-1059` comment claiming skips is **false**.
- **D3** trailing ↔ reconcile ping-pong (B1).
- **D4** `monitorWorkWake` cross-pokes all monitors on every trades write (amplifier; bounded by ticking guard).
- **D5** `hasWorkOnShard` fails open (`monitorIdleGate.ts:130-136`).
- **D6** postFillFollowUp has no reconcile pass (`postFillFollowUp.ts:300-303`) — a failed TP only heals if something else notices (B4 says nothing does).
- **D7** 2026-10-28 heal-loop class: config heal guards intact; **no equivalent unbounded write loop on stop tables**; nearest analogue = D1/D2.
- **D8** autoManagement has backoff+quarantine; **trailingStopMonitor has NO failure backoff** — permanently rejected trail re-fires every 400 ms.

## (e) Recent fixes: intact vs incomplete

**`e8def833` (2026-11-10)** — verdict: **partial**.
- all-TPs-behind-market guard: intact (`signalEntryPriceGuard.ts:93-119`, `entryPrepare.ts:936-997`).
- channelStopApply both-sides: intact but conditional on >0 (`:1055-1065`).
- orderModifySafe TP-retry carries SL: intact (`:194`); **SL-only step not covered** (`:141`, B3).
- postFillFollowUp/applySignalOverride counterpart+throw: intact.
- channelStopApply deferred-TP: incomplete (success+no job).
- other providers: **not attempted** (caller-level only, 4 paths).
- broker TP verification: **not added** (B4 remains).

**`468da314`** — partial-TP open-trade-scoped reads: intact; no stop writes (OrderClose only).
**`dd1c12f9`** — lot_size shrink after partial: intact; unrelated to stops.

## Highest-value gaps (ranked)
1. Broker TP never verified by v1 reconcile — structural reason wiped TPs stay wiped.
2. No per-trade/basket modify mutex — B1/B2 races.
3. Trailing absent from desired-state resolution → B1 ping-pong.
4. channelStopApply never reads `auto_be_applied_at` → B2 permanent BE revert.
5. `loadOpenBasketLegs` omits `cwe_close_price` → B7 within one sweep.
6. `orderModifySafe.ts:141` SL-only retry + success-without-job in channelStopApply.
7. One-sided/zero payloads in 7+ call sites.
8. Drift-sweep churn bounded per job but unbounded across jobs; `skipAlreadySynced` no-op.
