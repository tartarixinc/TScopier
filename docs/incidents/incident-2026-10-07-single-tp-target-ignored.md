# Incident report — "Single target TP" is ignored and the signal stop loss is not applied (2026-10-07)

**Detected:** 2026-10-07 · **Root cause confirmed:** 2026-10-08 · **Component:** trading worker — manual "Single" trade style, post-fill follow-up, take-profit reconciliation, signal parser · **Status:** Open (diagnosed, fix not yet written)

| Field | Value |
|---|---|
| Severity | High |
| Status | **Open** — root cause confirmed, no code change yet |
| Reported by | Denis Semsovic `<denis.semsovic@gmx.de>` (`7ee5c4f5-c0de-4944-9442-ae56d9abc09d`) |
| Affected users | 1 confirmed (Basic plan, MT5 demo). Blast radius: every account with a single take-profit target, every account using an override stop, and every account whose channel writes a stop in a format the parser does not know |
| Component | Trading worker — `postFillFollowUp`, `basketSlTpReconcile` / `basketReconcileTargets`, `channelStopApply`, `signalExecutionEligibility` |
| Root cause | A step that runs about one second after a fill replaces the customer's chosen take-profit with the last one in the signal and re-anchors the stop to the fill price, **without writing any record**. A second, independent path does the same thing minutes later through the reconciliation job. Separately, the parser drops the stop on two message formats and the AI repair step that should catch it never fires |
| Data impact | Live positions carrying a different take profit, and sometimes a different stop loss, than the customer configured — with no audit trail of the change |

**Decisions taken 2026-10-08:** the stop-loss re-anchoring **stays as it is** (it delivers the fixed distance the customer configured); what changes is that it becomes recorded and visible. The take-profit replacement is a defect and is fixed regardless.

---

## 1. Executive summary (plain English)

Denis sets **"Single target TP 3"** in Account Configuration. He reported two things: his trades end up at the signal's **last** take profit (sometimes TP6), and the signal's stop loss does not appear on the trade. He is right on both counts.

**The take-profit setting works for about one second.** When the copier places the order it uses the rung he chose — we can see it in the order record every time. Then a clean-up step that runs automatically just after the trade fills replaces it with the **last** take-profit in the signal. From his point of view the setting is ignored.

**The stop loss also moves, silently.** He has his account set to use a fixed stop distance rather than the signal's. The clean-up step measures that fixed distance again — but from the price the trade actually filled at, instead of the entry price written in the message. Same distance, different starting point, and nobody is told.

**Neither change writes a record.** In a six-minute window around his two trades there are exactly four rows in the trade log table: two dispatch entries, the order, and a summary. **No modify row of any kind.** That is the single reason this took two days to find — every other part of the system that touches an open trade writes a row; this one does not.

**A second, independent route reaches the same wrong answer.** His 15:46 trade was corrected two minutes later by the background reconciliation job, which had been given a "target take-profit" of zero and, when the broker rejected the substitute value, deliberately fell back to the furthest level in the signal. That path *does* write records, which is why it was found first.

**The parser is a third, separate defect.** Two very common ways the channels write a stop loss are not understood: `❌SL.TP 4105` and `SL ➡️(4110)`. Eight of the last thirty-one signals in his channel parsed with no stop at all. Two were dropped with a message telling *him* to go and configure a pre-defined stop — misleading, because the signals did contain one. An AI repair step already exists to rescue exactly this case, but the check that decides whether a parse is "broken" deliberately treats a missing stop as acceptable, so the AI is never asked. Separately, the marketing line `100% Sure confirm signal` was read as a take-profit level of **100**, and two trades were placed with it.

None of this has been fixed yet. This report is the diagnosis.

---

## 2. Issue encountered

### a) The chosen take-profit is applied, then replaced about one second later

Two trades, both his account, both XAUUSD, both on 2026-10-07. Times are UTC.

**Trade 1 — `c82f6e0f`, buy, signal `691bb779`**

The signal said: `BUY 4078–4088 · TP1 4093 · TP2 4095 · TP3 4097 · TP4 4100 · SL 4073`. He had chosen TP3.

| | Stop loss | Take-profit |
|---|---|---|
| Signal / what he asked for | 4073 | **4097** (TP3) |
| Order sent at 13:29:09.640661 | **4064** | **4097** ✓ |
| Trade row, final | **4076.44** | **4100** ✗ |

| Time | What happened |
|---|---|
| 13:29:07.131 | plan built: `anchorSource=signal anchor=4078 pip=0.1 stops_level=0 freeze_level=0 point=0.01` |
| 13:29:08.279 | trade row created, fill **4090.44** |
| 13:29:08.315 | `OrderSend ok ticket=600013647700 price=4090.49 1151ms` |
| 13:29:09.640661 | `order_send` row written — `stoploss 4064`, `takeprofit 4097` |
| 13:29:09–10 | **post-fill step changes both values; writes nothing** |
| 13:30:24 | first `[effectiveStops] sl=4076.44 source=channel_memory anchor_sl=4073` |

**Trade 2 — `47ae85cb`, sell, signal `48c21119`**

Signal: `SL 4115`, take-profits `4095, 4090, 4085, 4080, 4075, 4070, 4060`, entry `4100`. He had chosen TP3 of 7 = **4085**.

| | Stop loss | Take-profit |
|---|---|---|
| Signal / what he asked for | 4115 | **4085** (TP3) |
| Order sent at 14:04:43.105395 | **4114** | **4085** ✓ |
| Trade row, final | **4109.74** | **4060** ✗ |

| Time | What happened |
|---|---|
| 14:04:36.498 | `sendOrder … source=per_channel channel=42f98940… broker=ee5c1cf0…` |
| 14:04:39.873 | plan built: `anchor=4100 pip=0.1 stops_level=0 point=0.01` |
| 14:04:41.052 | trade row created, fill **4095.74** |
| 14:04:41.057 | `OrderSend ok ticket=600013692258 price=4095.82 1178ms` |
| 14:04:43.105395 | `order_send` row written — `stoploss 4114`, `takeprofit 4085` |
| 14:04:43+ | **post-fill step changes both values; writes nothing** |

### b) The audit gap, measured

Every action recorded for this user across the whole of 13:29:00–13:35:00:

| action | rows |
|---|---|
| `dispatch_push_attempt` | 2 |
| `order_send` | 1 |
| `pipeline_summary` | 1 |

Four rows. **No modify, no post-fill, no basket row — under any action name.**

The same query over 14:04:40–14:10:00, filtered to anything matching modify / post_fill / basket, returns **empty**.

Meanwhile `trades.sl` and `trades.tp` both changed on both trades. The only code that changes them and writes nothing is `postFillFollowUp`.

#### b.1) The broker's own log — exact millisecond ordering

Read from the bridge container's log on the production server (`OrderSendSafe` / `OrderModifySafe`, single clock, UTC):

| Bridge time | Event |
|---|---|
| 13:29:07.686330 | `OrderSendSafe` starts — `symbol=XAUUSD operation=Buy volume=0.02 price=4090.49 stoploss=4064 takeprofit=4097 comment=TScopier:FXGoldSniper:691bb779 id=15c2ed63-8050-4dcb-ba4c-ae0d0b1dae00` |
| 13:29:08.698627 | `OrderSendSafe` finishes — HTTP 200, 719.86 ms |
| **13:29:08.698656** | **`OrderModifySafe` starts — `ticket=600013647700 stoploss=4076.44 takeprofit=4100 id=15c2ed63…`** |
| 13:29:09.017580 | `OrderModifySafe` finishes — HTTP 200, 421.28 ms |

**29 microseconds** separate the order completing from the change beginning. The modify carries exactly the predicted values: fill − 14.00 = 4076.44, and the last level of the signal ladder, 4100.

Two things this proves:

1. The change happens **in the same execution step as the fill**, not seconds or minutes later. The timing caveat is closed.
2. The bridge returned **200**, so the values were applied **at the broker**, not merely written into our own database.

The URL also carries `id=15c2ed63-8050-4dcb-ba4c-ae0d0b1dae00` — the broker account later deleted, confirming the configuration in force is unrecoverable (see §8).

#### b.2) The audit row for the order lands *after* the trade was already changed

The `order_send` row is timestamped **13:29:09.640661** — **942 ms after** the modify had already been sent to the broker.

`worker/src/tradeExecutor/orderLegExecution.ts:895`:

```ts
} else if (liveEntryFast) {
  filledLegs.push(filledLeg)
  void (async () => {                       // NOT awaited
    const tradeRowId = await insertTradeRowWithFkRetry()
    filledLeg.tradeRowId = tradeRowId
    await persistPostFillDb(tradeRowId)     // the order_send insert lives inside here
    ...
  })().catch(err => { … })
}
```

On the live-fast path the database write is fired into the background while `applyPostFillFollowUp` is launched separately at `:1070`. They race. In this case **the modify won by 942 ms.**

The audit trail therefore does not merely miss the change — on this path it records the order **after** the order has already been altered. It is also the reason `leg.tradeRowId` may still be `null` when the post-fill step runs, in which case the `trades.update` at `postFillFollowUp.ts:231` is skipped and only the broker ends up holding the new values.

### c) The arithmetic — one constant, two anchors

Both stops are the fill price shifted by exactly **14.00**, in the correct direction for the side. The plan lines record `pip=0.1`, so 14.00 = **140 pips**.

| Trade | Side | Signal entry (anchor) | Fill | Sent SL = anchor ∓ 14.00 | Final SL = fill ∓ 14.00 |
|---|---|---|---|---|---|
| `c82f6e0f` | buy | 4078 | 4090.44 | 4078 − 14 = **4064** ✓ | 4090.44 − 14 = **4076.44** ✓ |
| `47ae85cb` | sell | 4100 | 4095.74 | 4100 + 14 = **4114** ✓ | 4095.74 + 14 = **4109.74** ✓ |

Two independent trades, opposite sides, both landing exactly on fill ∓ 14.00 with `pip = 0.1`. The minimum-distance clamp in the planner cannot produce this — a clamp never *shortens* a stop. A fixed pip distance measured from a different anchor is the only mechanism that fits both.

### d) The take-profit came from the signal ladder, not from a pip setting

The final take-profits are **4100** and **4060** — the last entry of each signal's ladder.

If they had come from a pip-based take-profit setting on top of the fill, they would be `4090.44 + [20,40,60] × 0.1` = 4092.44 / 4094.44 / 4096.44. They are not.

So at the moment of the change: the stop override was **on**, the take-profit override was **off**, and the take-profit came straight from `parsed.tp` — with the last element selected.

### e) A second, independent route — the 15:46 trade

Trade `363602ad` does not involve the post-fill step at all:

```
15:46:09  channel params saved:  sl 4098, tp_levels [4112,4116,4120,4124,4128]
15:46:16  order_send             takeprofit = 4120   <-- TP3, what he asked for
15:47:29  drift sweep            enqueued reconcile job (legs = 1)
15:49:38  basket_leg_modify      target_sl = 4098, target_tp = 4128   <-- the FURTHEST TP
15:49:39  basket_reconcile_tick
15:49:40  merge_modify_summary
```

The same shape on earlier days, all with modify records:

```
10-05 11:56  order_send tp=4164.42  ->  11:57  modify target_tp=4161
10-05 13:53  order_send tp=4144     ->  13:55  modify target_tp=4160
10-06 01:50  order_send tp=4142     ->  01:53  modify target_tp=4150
10-06 14:48  order_send tp=4162     ->  14:55  modify target_tp=4170 (5 failures, success 15:04)
```

Trades that were never re-modified keep the chosen level (`3cbc3471` → TP3, `69c72b5a` → TP3). That is how we know the setting itself is read correctly at order time.

### f) The parser misses two stop-loss formats

Reproduced locally against `parseChannelMessageSync` + `DEFAULT_CHANNEL_KEYWORDS`, and identical to what is stored in `signals.parsed_data` in production:

| Message as sent in the channel | parsed `sl` | parsed `tp` |
|---|---|---|
| `GOLD SELL NOW 4095 … ❌SL.TP 4105` + `100% Sure confirm signal` | **null** | `[4090,4085,4080,4075,4070,4065, **100**]` |
| `GOLD BUY NOW 4073 … ❌SL.TP 4063` + `100% Sure confirm signal` | **null** | `[4078,…,4103, **100**]` |
| `TP¹ ↗ (4125) … ❌SL➡️(4110)` | **null** | **`[]`** |
| `GOLD BUY NOW 4108 … SL 4098` (control) | 4098 | `[4112,4116,4120,4124,4128]` |

**Sizing: 8 of the last 31 signals in this channel parsed with `sl = null` (26%).**

What that produced in production on 2026-10-07:

* `9645afc5` — opened with **`sl = 0, tp = 0`**: no stop loss at all. Signal said `❌SL➡️(4110)`.
* `917bd11c` — opened with `sl = 4082.31`, `tp = 0`. Signal said `❌SL➡️(4080)`.
* `d34beee6`, `2288ce98` — `order_send takeprofit = 100`; `trades.tp = 100`.
* The stop losses that *were* applied came from the channel's remembered parameters (`source = channel_memory`), not from the signal itself.

Three signals were dropped before an order was sent (`reason_code = entry_tp_without_sl`, text *"SL not given — set predefined SL pips in broker configuration"*):

| Dropped (UTC) | Signal | Raw message | Real reason |
|---|---|---|---|
| 00:45:17 | `baa0bd4e` | `GOLD SELL NOW 4165 … ❌SL.TP 4176 100% Sure…` | parser returned `sl = null` |
| 09:13:08 | `071d275f` | `GOLD BUY NOW 4120 … ❌SL.TP 4110 100% Sure…` | parser returned `sl = null` |
| 15:34:01 | `74889d70` | `GOLD BUY 4090 To 4110 🔥✅` | genuinely no SL in the message |

Two of the three **did contain a stop loss**. The message blames the customer for our parser.

### g) Why the AI repair step never ran

An AI repair step already exists. In `worker/src/userListener.ts:2654`, when the machine-readable parse "needs repair", the original message is handed to the AI and it tries again.

The decision is made by `deterministicEntryNeedsAiRepair` (`worker/src/signalExecutionEligibility.ts:112`), which returns false whenever the parse is classed as *eligible*. And the eligibility check deliberately does not treat a missing stop as a failure — there is a comment in the code saying so:

```ts
// TP-without-SL is an *account* decision (predefined/RR SL can supply the stop).
// Do not skip the signal here — entry prep still blocks accounts with no fallback.
```

So for `GOLD SELL NOW 4095 … ❌SL.TP 4105`: the action and take-profits parse, `sl` is null, eligibility passes because an account-level fallback could supply the stop, `deterministicEntryNeedsAiRepair` returns false, and **the AI is never asked**.

The `100` survives for a related reason. `filterPlausibleInstrumentPrices` (`worker/src/tradableSymbol.ts:376`) drops prices below the minimum plausible quote for the symbol, but the eligibility check only rejects the list when `plausibleTps.length === 0` — that is, when *every* entry is impossible. Four valid gold prices beside one absurd one passes. The filter result is never written back into the parse, so `100` stays in `parsed_data` and reaches the broker.

### h) Confirmed against the customer's own settings

```json
{ "trade_style": "single", "single_tp_target": "tp2",
  "tp_lots": [ { "TP1": 0 }, { "TP2": 100 }, { "TP3": 0 } ],
  "use_predefined_sl_pips": false, "use_predefined_tp_pips": false,
  "range_trading": false }
```

Plan limits (`src/lib/planLimits.ts`) force `trade_style = 'single'` on Basic and cap Targets % at three rows, but they do **not** restrict `single_tp_target` — so the control he is using is legitimate for his plan.

Account and channel settings disagree, which is the substance of defect 3 below:

| Where | single take-profit target |
|---|---|
| Account setting | `tp2` |
| Channel `7858264d…` | `tp2` |
| Channel `ceb638d0…` | `tp3` |
| Channel `eed57614…` | `tp3` |

Opening a trade resolves through `resolveChannelTradingConfig` and can pick `tp3`; that resolved value is written back onto the broker record and is the same record the post-fill step later reads. So the post-fill step was never using a *different* source — but it was never using the resolved **target** either, because it never reads `single_tp_target` at all.

---

## 3. Affected user(s)

| User | Trade | Symbol | Side | Opened (UTC) | What is wrong |
|---|---|---|---|---|---|
| `7ee5c4f5…` (Denis Semsovic) | `c82f6e0f` | XAUUSD | buy | 2026-10-07 13:29:08 | opened at TP3 4097, final `trades.tp` **4100** (last); sent SL 4064, final **4076.44**, signal said 4073. **No audit row** |
| " | `47ae85cb` | XAUUSD | sell | 2026-10-07 14:04:41 | opened at TP3 4085, final `trades.tp` **4060** (last); sent SL 4114, final **4109.74**, signal said 4115. **No audit row** |
| " | `363602ad` | XAUUSD | buy | 2026-10-07 15:46:13 | opened at TP3 4120, `basket_leg_modify` set **4128** (last) at 15:49:38 — reconcile route |
| " | `9645afc5` | XAUUSD | buy | 2026-10-07 09:23:29 | **`sl = 0, tp = 0`** — no stop loss at all |
| " | `917bd11c` | XAUUSD | buy | 2026-10-07 13:20:30 | `tp = 0`; SL came from channel memory, not the signal |
| " | `d34beee6`, `2288ce98` | XAUUSD | sell | 12:35 / 13:03 | `trades.tp = 100` (the "100%" line) |
| " | 3 signals | XAUUSD | — | 00:45 / 09:13 / 15:34 | dropped: `entry_tp_without_sl`, two of them containing a stop we failed to read |

Broker account in force at the time: `ee5c1cf0-fcaf-4254-a1c1-753fa6827fda` — **since deleted**. Current account `0ca80cfb…` ("Demo", MT5, mtapi). 58 of his 59 trade rows have `broker_account_id = NULL` because of `ON DELETE SET NULL`.

---

## 4. Root cause

**Three independent defects.**

### Defect A — the post-fill step replaces the chosen take-profit and re-anchors the stop, and records nothing

`applyPostFillFollowUp` is launched without awaiting from `worker/src/tradeExecutor/orderLegExecution.ts:1084`, inside `if (liveEntryFast && filledLegs.length > 0)`, which is **after** the `order_send` row is written at `:751`. It runs about a second after the fill.

Inside `worker/src/postFillFollowUp.ts`, `applyPipAndChannelStops` walks four branches:

| Line | Condition | Behaviour |
|---|---|---|
| 161 | `isMulti` | derives stops from the fill |
| 179 | `hasPartialTpSchedule && plannedBrokerTp > 0` | keeps the planned take-profit |
| **181** | **`usesPredefinedStops(manual)`** | **derives stop from the fill, take-profit = `finalTps[last]`** |
| 197 | `shouldMergeChannelParamsForEntry` | takes the last positive parsed take-profit |

Denis took branch 3. `usesPredefinedStops` (`worker/src/manualPlanning/manualStops.ts:10-12`) is true if **either** override is on — his stop override was on, his take-profit override was not.

- **Stop:** `entry = leg.entryPrice` (line 116) is the fill. `deriveManualStopsWithClamp` is called with `entryAnchor: entry` at `:183`. Because `usePreSl` is true, `parsed.sl` is discarded (`manualStops.ts:288`) and `finalSl` is recomputed as `entryAnchor − slPips × pip` (`manualStops.ts:305-311`) → **4076.44**.
- **Take-profit:** `usePreTp` is false, so `finalTps` is `parsed.tp` unmodified — the signal ladder `[4093,4095,4097,4100]`. Then `:193-195`:

```ts
if (derived.finalTps.length) {
  const lastTp = derived.finalTps[derived.finalTps.length - 1] ?? derived.finalTps[0]
  targetTp = derived.roundPrice(lastTp)
}
```

  → **4100**. `plannedBrokerTp` (4097) is only consulted at `:179`, which requires `hasPartialTpSchedule` — false for a single target with no partial schedule.

- **The record:** `api.orderModify` at `:223`, `trades.update` at `:231-236`. The only `insert` in the entire file is `post_fill_news_audit` at `:292`, which fires only during a news blackout. **There is no `trade_execution_logs` insert on the modify path.**

The clamp at `manualStops.ts:322-342` cannot explain 15 → 14: a minimum-distance clamp never shortens a stop. The fixed pip distance measured from a second anchor is the only mechanism that fits both trades.

### Defect B — the reconciliation layer reaches for the furthest take-profit

`single_tp_target` is read in exactly five places, none of them post-entry:

* `worker/src/manualPlanning/planSingleManualOrders.ts:56`
* `worker/src/manualPlanning/partialTpSchedule.ts` (`resolveSingleTpTargetIndex`, `planSinglePartialTps`)
* `worker/src/manualPlanning/normalizeManualSettings.ts:115-129`
* `worker/src/tradeExecutor/basketMerge/slTpRefresh.ts:428`
* `worker/src/tradeExecutor/strictEntryPending.ts:15`

Every path that runs **after** the order is open — `basketSlTpReconcile.ts`, `basketReconcileTargets.ts`, `channelStopApply.ts`, `rangeBasketTpSync.ts`, `openTradeReconcileMonitor.ts`, `tradeBrokerDriftMonitor.ts`, `autoManagementMonitor.ts`, `partialTpMonitor.ts` — works from the full signal ladder.

Mechanism for the 15:46 trade:

1. `sweepOpenBasketsForReconcileDrift` calls `resolveFreshBasketReconcileTargets` (`worker/src/basketReconcileTargets.ts:495`) with `storedTargets: []`.
2. The non-range branch (`:181-199`) seeds `{ stoploss: 4098, takeprofit: 0 }` and calls `expandPerLegTargetsToCount` (`worker/src/manualPlanning/tpBucketDistribution.ts:112`), which short-circuits `if (targets.length >= n) return targets.slice(0, n)` — the target take-profit stays **0**. No branch consults `single_tp_target`.
3. `stopsAlreadyMatchDb` (`worker/src/orderModifyBenign.ts:56-68`) only compares take profit when `target.takeprofit > 0`, so a zero target looks "already correct".
4. When the job runs, `basketSlTpReconcile.ts` falls back to `modTp = tr.tp` (`:538-543`), and then at `:601-607`:

```ts
// If the requested TP was passed by price, fall back to the deepest ladder
// TP so the leg keeps a profit target.
const deepestTp = parsedTps.length
  ? (direction === 'buy' ? Math.max(...parsedTps) : Math.min(...parsedTps)) : 0
const safe = await modifyLegSlTpWithFallback(api, uuid, ticket, modSl, modTp, { deepestTp })
```

5. `modifyLegSlTpWithFallback` (`worker/src/orderModifySafe.ts:128-150`) tries the requested take profit and, if the broker rejects it with "invalid stops", **silently retries with `deepestTp`**. The success log records `targetTp: safe.appliedTp`, and `basketSlTpReconcile.ts:652-660` writes it into `trades.tp`.

`channelStopApply.ts:805` compounds it with `buildEntryQualityTakeProfitMap`, and `rangeBasketTpSync.ts` has explicit `fillZeroTargetsWithDeepest` / `deepestFinalTp` helpers.

**Chain:** chosen take-profit applied at `OrderSend` → drift sweep enqueues a job with a zero target → reconcile falls back to the existing value → "invalid stops" fallback replaces it with the deepest ladder level → `trades.tp` and the broker both hold the furthest target.

### Defect C — the parser drops the stop, and the rescue step never fires

`worker/src/parseSignal.ts` (`parseChannelMessageSync`, `DEFAULT_CHANNEL_KEYWORDS`) has no rule for:

* **`SL.TP <price>`** → `sl = null`.
* **Parenthesised values**, `TP¹ ↗ (4125)` / `SL ➡️(4110)` → both `sl` and `tp` come back empty.

And an over-eager rule treats a bare `100` as a price, so `100% Sure confirm signal` becomes a take-profit level of **100**.

The rescue that should catch this is `deterministicEntryNeedsAiRepair` → `tryAiEntryParse` (`worker/src/userListener.ts:2654`), but eligibility treats a missing stop as acceptable by design (see §2g), so it never triggers. `filterPlausibleInstrumentPrices` (`worker/src/tradableSymbol.ts:376`) sees that `100` is impossible but only rejects the list when *all* entries are, and never writes the filtered result back.

---

## 5. The fix

**Not implemented yet.** Ordered, with the decisions taken 2026-10-08 applied.

### Part 1 — the post-fill step (defect A)

1. **Keep the chosen take-profit.** When a single take-profit target is set and there is no partial schedule, do not recompute — the order already carries the right value. Where a partial schedule exists, use `plannedBrokerTp` instead of `finalTps[last]`.
   *`worker/src/postFillFollowUp.ts:193-195`, `:197-201`.*
2. **Stop calculation: unchanged**, per the decision above. It continues to re-measure the fixed distance from the fill.
3. **Write an audit row for every change** — before value, after value, ticket, and the reason. This is the highest-value change in the whole plan; without it this class of incident stays invisible.
   *`worker/src/postFillFollowUp.ts:223` onward; the file's only insert today is `:292`.*
4. **Surface the final stop in the trade details** so the re-anchoring stops being a surprise.

**Withdrawn:** an earlier draft of this plan included *"read one settings source"* on the grounds that the post-fill step read account settings while entry read channel settings. **That was wrong.** `withChannelTradingConfig` (`worker/src/channelTradingConfig.ts:280`) rewrites `manual_settings` onto the broker row at `worker/src/tradeExecutor/TradeExecutor.ts:1437`, and all four entry constructions (`:1525`, `:1533`, `:1622`, `:1630`) pass that same `effectiveBroker`. The post-fill step receives already-resolved channel settings. No split-brain exists on this path.

### Part 2 — the reconciliation path (defect B)

6. Thread `single_tp_target` into `resolveFreshBasketReconcileTargets` (both branches), `resolveFreshTargetsForJob`, `sweepOpenBasketsForReconcileDrift` — `worker/src/basketReconcileTargets.ts`.
7. Stop preferring `deepestTp`; prefer the chosen target — `worker/src/basketSlTpReconcile.ts:601-607`, `:652-660`.
8. `expandPerLegTargetsToCount` must accept the target and use it when the seeded take-profit is 0 — `worker/src/manualPlanning/tpBucketDistribution.ts:112`.
9. A zero target take-profit must not count as "in sync" when a single target is set — `worker/src/orderModifyBenign.ts:56-68`. **Do not change the zero-target rule in isolation** — it is shared with `applySignalOverride.ts:329`, `channelStopApply.ts:896`, `basketReconcileTargets.ts:260`.
10. `buildEntryQualityTakeProfitMap` must honour the target — `worker/src/channelStopApply.ts:805`.

### Part 3 — the parser (defect C)

11. **Teach it the two formats** — `SL.TP <price>` and parenthesised `SL ➡️(…)` / `TPⁿ (…)` — `worker/src/parseSignal.ts`.
12. **Never read a number immediately followed by `%` as a price**, and write the plausibility filter's result back into the parse — `worker/src/parseSignal.ts`, `worker/src/tradableSymbol.ts:376`.
13. **Make the rescue step fire** — treat "the message contains a stop but the parser returned none" and "a take-profit that cannot be a real price" as needing repair — `worker/src/signalExecutionEligibility.ts:112`, called from `worker/src/userListener.ts:2654`.
14. **Withhold honestly** — distinguish *"we could not read it"* from *"there is none"*, and decide whether an account-level fallback stop should still let the trade through — `worker/src/brokerTradeError.ts:57`, `worker/src/tradeExecutor/entryPrepareMissingSl.ts`, message text in 14 files across `src/i18n/locales/` and `src/i18n/channelWorker/`.
15. **Prove it** — replay the 31 real signals through the changed parser with the `replay-parse` diagnostic. Target: 8 broken → 0, 23 working unchanged.

### Part 4 — release

16. **One worker release**, built on `staging`, full test suites, deploy staging, watch, then production.

**Withdrawn:** an earlier draft included a **customer notice in 10 languages**. Not to be sent.

**Deployment order:** Part 1 → Part 2 → Part 3 → release, one deployment.

**Release-day sign-offs (both are behaviour changes):**

* Trades will now close at the rung the customer picked instead of the furthest one. Expect and watch for this.
* The take-profit hand-edit alert activates with Part 1 (`[MANUAL_OVERRIDE_NOTIFY] … reason=db_not_managed_targets`, `manualBrokerOverrideNotification.ts:154`). It will start reporting events it previously stayed quiet about. Needs a deliberate yes on release day.

---

## 6. Files changed

None yet. Diagnosis only.

| File | Planned change |
|---|---|
| `worker/src/postFillFollowUp.ts` | keep chosen take-profit; audit row; stop unchanged |
| `worker/src/channelStopApply.ts` | honour target in `buildEntryQualityTakeProfitMap` |
| `worker/src/basketReconcileTargets.ts` | thread `single_tp_target` into fresh targets / drift sweep |
| `worker/src/basketSlTpReconcile.ts` | honour it in the job target; stop preferring `deepestTp` |
| `worker/src/manualPlanning/tpBucketDistribution.ts` | `expandPerLegTargetsToCount` accepts the target |
| `worker/src/orderModifyBenign.ts` | zero target TP is not "in sync" when a single target is set |
| `worker/src/parseSignal.ts` | `SL.TP`, parenthesised values, `100%` false positive |
| `worker/src/tradableSymbol.ts` | write the plausibility filter result back into the parse |
| `worker/src/signalExecutionEligibility.ts` | fire the AI repair for a missing stop and an impossible take-profit |
| `worker/src/brokerTradeError.ts` | correct the `ENTRY_TP_WITHOUT_SL` wording |
| `worker/src/tradeExecutor/entryPrepareMissingSl.ts` | decide the fallback-stop policy |
| `src/i18n/locales/*`, `src/i18n/channelWorker/*` | corrected message text (14 files) |

---

## 7. Verification

Diagnosis verification performed:

| Check | Result |
|---|---|
| Prod DB: settings, trades, `trade_execution_logs`, `signals.parsed_data` | read directly (read-only Management API queries) |
| Order → final values for `c82f6e0f` and `47ae85cb` | sent 4064/4097 → final 4076.44/4100; sent 4114/4085 → final 4109.74/4060 |
| Audit gap, 13:29:00–13:35:00, all action names | 4 rows: `dispatch_push_attempt` ×2, `order_send`, `pipeline_summary`. **No modify row** |
| Audit gap, 14:04:40–14:10:00, modify / post_fill / basket | **empty** |
| Arithmetic on both stops | fill ∓ 14.00 exact; plan lines record `pip=0.1`, `anchorSource=signal`, `stops_level=0` |
| Take-profit source | final values equal the last entry of each signal ladder, not pip-derived values from the fill |
| Railway production logs, grep `4076.44` | only `[effectiveStops]` lines from 13:30:24 onward, `source=channel_memory anchor_sl=4073`; nothing at 13:29 |
| Prod DB: order → modify sequence 2026-10-05 … 10-07 | reproduce the reconcile overwrite on 6 trades |
| Local parser reproduction | all three failure formats reproduced; matches stored `parsed_data` exactly |
| Code trace | post-fill modifies with no insert; `single_tp_target` absent from every post-entry path; AI repair gated by eligibility |
| Bridge container log, `OrderSendSafe` / `OrderModifySafe` at 13:29 | order completes **13:29:08.698627**, modify begins **13:29:08.698656** — 29 µs apart, same ticket, `stoploss=4076.44 takeprofit=4100`, HTTP 200. **Broker applied the values.** See §2b.1 |
| Bridge log vs. the `order_send` row | `order_send` written **13:29:09.640661** — 942 ms *after* the trade was already changed. On the live-fast path the insert is fired un-awaited (`orderLegExecution.ts:895`) and races post-fill at `:1070`. See §2b.2 |

**Not yet verified:**

| Check | Status |
|---|---|
| The two source addresses in the server access log (`152.55.178.36`, `152.55.178.39`, UA `node`) are our worker's egress | **pending** — if they are not, this is a security incident, not a bug |

No fix exists yet, so no fix verification has been run.

---

## 8. Limitations

**The settings in force at 13:29 and 14:04 cannot be read.** Broker `ee5c1cf0-fcaf-4254-a1c1-753fa6827fda` and channel `42f98940-a5b0-4b94-baa7-f3d04fdbecd1` have both been deleted, and their settings went with them. Every surviving settings record says something different — the current account reads `use_predefined_sl_pips: false, predefined_sl_pips: 30`, and **no record anywhere holds `predefined_sl_pips = 140`**.

The values reported here — **an active stop override at 140 pips (14.00 points) with the take-profit override off** — are **inferred from what the system did, not read from a record**. The inference is strong: two independent trades on opposite sides both land exactly on fill ∓ 14.00 with `pip = 0.1`, and the take-profits match the signal ladder rather than any pip-derived value. It is still an inference.

Settings are hard-deleted with their parent rows, so this class of question is unanswerable after the fact. Making them auditable needs a history table.

---

## 9. Deployment status

| Environment | Status |
|---|---|
| staging | not started |
| production | not started — **the defect is live** |

---

## 10. Follow-ups

**Resolved by this investigation:**

1. ~~Explain `trades.tp = 4100` / `4060` on `c82f6e0f` / `47ae85cb`.~~ **Answered:** `postFillFollowUp` wrote them directly to `trades` at `:231-236`. It has no `trade_execution_logs` insert, which is why no modify row exists. Confirmed by the four-row window in §2b.
2. ~~Explain the two stop-loss variances (4073 → 4064, 4115 → 4114).~~ **Answered:** a 140-pip override re-anchored from the signal entry at order time and from the fill at post-fill time. See §2c and defect A.

**Open:**

3. **Implement parts 1–3** (§5).
4. **Resolve `tp2` vs TP3.** Stored `single_tp_target` is `tp2` but every order since 13:29 used TP3, and `broker_accounts.updated_at` equals `created_at`, so we cannot see when it changed. Add an `updated_at` trigger (or log the resolved target on every `order_send`) so this is answerable next time. Confirm with the customer which value he believes he set. Note that this is now *expected* behaviour under the channel/account split — `resolveChannelTradingConfig` legitimately returns `tp3` for two of his channels while the account says `tp2`.
5. ~~**Exact millisecond ordering.~~ **Answered** from the bridge's own log — §2b.1 (29 µs) and §2b.2 (the `order_send` row lands 942 ms late).
6. **Confirm the two access-log source addresses** are our worker's egress.
7. **Why the drift sweep fired at 15:47:29** when `stopsAlreadyMatchDb` should pass with a zero target TP — check the broker `/OpenedOrders` comparison in `basketLegsOutOfSyncOnBroker`.
8. **`basket_reconcile_jobs` rows are deleted after completion**, which blocks job-state forensics. Consider retaining the last N jobs per anchor signal.
9. **Settings hard-delete.** Add a history table so a deleted broker's configuration stays readable.
10. **Blast radius sizing.** 522 trades in 30 days had their take-profit rewritten after opening; 297 were pushed to the last level. Every `trade_style = single` account is exposed. Eight accounts are simultaneously `trade_style = single` **and** `range_trading = true`, which is a separate mismatch worth sizing.
11. **Deploy-day sign-offs** (§5 Part 4) — trades move to the chosen rung; the take-profit hand-edit alert switches on.
