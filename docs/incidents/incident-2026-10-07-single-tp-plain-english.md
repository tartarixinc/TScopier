# Single target TP — plain English explanation, action list, and open work

**Date:** 2026-10-07 · **Customer:** Denis Semsovic · **Companion to:** `incident-2026-10-07-single-tp-target-ignored.md`

---

## 1. What is moving, and why

Two prices on the trade change **after** it has already opened, by themselves, within about one second.

Take the first trade. The signal message said:

> BUY 4078–4088 · TP1 4093 · TP2 4095 · TP3 4097 · TP4 4100 · SL 4073

You chose TP3. Here is what happened, step by step:

| | Stop loss | Take-profit |
|---|---|---|
| What you asked for | 4073 (from the signal) | **4097** (your TP3) |
| Trade opens with | 4064 | **4097** ✓ |
| One second later, by itself | **4076.44** | **4100** ✗ |

**Why the stop moves:** a clean-up step runs after every fill. You have your account set to "use my own fixed stop distance instead of the signal's", so the copier uses a fixed 14-point stop. That step re-measures the 14 points from the actual price the trade got filled at (4090.44) instead of the entry price written in the message (4078). 4090.44 − 14 = 4076.44.

Same distance, different starting point. It is defensible — but nobody asked for it, and in this case it moved the stop closer to the price, so the trade can be knocked out sooner than you expected.

**Why the take-profit moves:** while doing that, the same step replaces your chosen rung with the last take-profit in the signal — 4100 instead of 4097. That is simply wrong, and it is the exact complaint you reported.

The second trade is identical in reverse (stop 4114 → 4109.74, take-profit 4085 → 4060).

So the choice for you is only about the stop loss. **Decision taken 2026-10-08: leave it as it is** — it keeps delivering the fixed distance you actually configured. What changes is that it will be recorded and shown, instead of happening in silence. The take-profit bug is a bug either way and gets fixed regardless.

---

## 2. The log fix — run this

Log onto the server and paste the whole block. It is safe to run as-is, but it stops trading for about 5 seconds, so pick a quiet moment.

```bash
# 1. set a size limit so this cannot happen again
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" }
}
EOF

# 2. stop the trading services
docker stop mtapi mt4rest

# 3. clear the 2.9 GB
find /var/lib/docker/containers -name '*-json.log' -exec truncate -s 0 {} +

# 4. restart Docker so the limit applies
systemctl restart docker

# 5. bring trading back
docker start mt4rest mtapi

# 6. check the result
df -h /
du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail -5
```

Expected: disk usage drops from 6.5 GB to roughly 3.6 GB, and no log file is above 50 MB.

Two honest notes:

- **These two containers were created before the limit existed**, so they keep their old unlimited setting until they are next recreated. I will add the limit to the installer file so a rebuild cannot drop it — that is a code change, so it goes through review first.
- Your server also has **security updates and a restart pending**. Unrelated to this; do it separately.

Also worth running while you are on there — it settles the timing question (item 4):

```bash
grep -h "OrderSendSafe\|OrderModifySafe" "$(docker inspect -f '{{.LogPath}}' mtapi)" | grep "2026-10-07T13:29"
```

---

## 3. Items 4–12 in full

### 4. Pull the exact millisecond timestamps

- **What:** get the precise times the broker was asked to open the trade and then to change it.
- **Why:** three systems are involved — our worker, the database, and the bridge — and their clocks differ by fractions of a second. I worked out the order by arithmetic. One measurement turns an inference into proof.
- **How:** one command above, reading the bridge's own log, which records milliseconds.
- **When:** now, one minute.
- **Where:** production server, the bridge container's log file.
- **Outcome:** either the timing is confirmed and the fix target is settled, or it is not and I keep looking. No downside.

### 5. Confirm the two source addresses are ours

- **What:** the server's access log shows two internet addresses repeatedly sending the change requests, identifying themselves as our code.
- **Why:** if they are our worker, nothing to see. If they are not, someone else is placing and altering orders on this platform — a security incident, not a bug.
- **How:** compare them against the addresses our hosting provider assigns to the worker, and check the same addresses also appear on ordinary trade openings.
- **When:** now, alongside item 4.
- **Where:** server access log; our hosting provider's network records.
- **Outcome:** "confirmed ours, closed" — or an immediate escalation.

### 6. The settings in force cannot be read

- **What:** the broker account and the channel used for these two trades have been deleted, and their settings were deleted with them. Every surviving settings record says something different.
- **Why it matters:** my claim that your fixed-stop override was on with a 14-point distance is inferred from what the system did, not read from a record. I cannot show you the entry.
- **How:** nothing to run. I state the limitation plainly in the report rather than presenting it as fact.
- **When:** while writing the report.
- **Where:** the report's limitations section.
- **Outcome:** an honest report. If we ever want this auditable, settings need a history table instead of being hard-deleted.

### 7. Fix the post-fill step (the core fix)

- **What:** change the step that runs just after a trade opens so it (a) keeps the take-profit you chose, (b) records what it did to the stop — the stop calculation itself does **not** change, per the decision above — and (c) writes a record of every change it makes.
- **Why:** this step is what swapped your TP3 for the furthest take-profit and moved the stop — and it is the only place in the whole system that changes a trade without writing a single row to the trade log table. That silence is why this was invisible for so long.
- **How:** replace "use the last take-profit in the signal" with "use the index the customer selected"; add a log record for every change.
- **When:** first item built, part of the single release.
- **Where:** `worker/src/postFillFollowUp.ts` — the take-profit choice is line 194, the stop lines 182–196, and there is no logging anywhere in the file.
- **Outcome:** your TP3 stays TP3 on every trade; the stop behaves predictably; every change appears in the trade log.

### 8. Unify where settings are read from — **withdrawn 2026-10-08**

- **What I claimed:** opening a trade reads the channel's settings while the post-fill step reads the account's, so the two could disagree.
- **Why it was wrong:** I compared two files side by side without tracing the object between them. In fact the settings are resolved to the channel's values **once**, written back onto the broker record itself (`worker/src/tradeExecutor/TradeExecutor.ts:1437`), and that single record is what both the opening and the post-fill step receive. There is only ever one set of settings in play.
- **Outcome:** no change needed. Recorded as a withdrawn claim so nobody re-opens it later. A separate, unrelated question — whether the *management* paths read settings consistently — stays on the follow-up list, unproven either way.

### 9. Decide which stop wins when several sources disagree

- **What:** five different things can hold a stop loss for the same trade — the signal, the channel's memory, the basket's own target, a manual user override, and automatic break-even. Today they are ranked, but the ranking has holes, and trades are identified at the broker in more than one way. Also: decide what the system should do when a requested target can never be reached, and list every place take-profits get written.
- **Why:** multiple writers competing is what produces repeated overwrites — measured at 522 trades in 30 days, 297 of them pushed to the last take-profit.
- **How:** fix one priority order and enforce it; add guards; inventory the writers.
- **When:** same release, part 1 of the agreed plan.
- **Where:** `worker/src/basketEffectiveStops.ts` (the ranking), `worker/src/basketSlTpReconcile.ts`, `worker/src/basketReconcileTargets.ts`.
- **Outcome:** exactly one authoritative stop and take-profit per trade, and far fewer pointless calls to the broker.

### 10. Fix how a signal with no stop loss is handled (five parts)

8 of the last 31 signals in that channel were parsed with no stop loss at all. Five separate changes are needed, not one.

#### 10a. Teach the parser the two formats it cannot read

- **What:** two ways the channel writes a stop loss are invisible to the first stage of parsing — `❌SL.TP 4105` returns no stop, and `TP¹ ↗ (4125) … ❌SL➡️(4110)` returns neither a stop nor a take-profit.
- **Why:** those are the formats behind the 8 broken parses.
- **How:** add rules for both forms.
- **Where:** `worker/src/parseSignal.ts`.
- **Outcome:** those messages parse correctly the first time.

#### 10b. Stop reading `100%` as a price

- **What:** the marketing line `100% Sure confirm signal` is turned into a take-profit level of **100**.
- **Why it survives today:** the price-plausibility check only throws a list away if *every* entry is impossible. Four valid gold prices next to one absurd one still passes, so 100 stays in the parse and reaches the broker. Two trades went out with a take-profit of 100.
- **How:** never read a number immediately followed by `%` as a price, and remove implausible levels from the stored parse instead of only checking them.
- **Where:** `worker/src/parseSignal.ts`, `worker/src/tradableSymbol.ts` (line 376).
- **Outcome:** no trade is ever placed at 100.

#### 10c. Make the AI repair step actually fire

- **What:** an AI repair step **already exists**. When the machine-readable parse looks broken, the original message is sent to the AI and it tries again. It is never triggered for a missing stop loss.
- **Why:** the check that decides whether a parse is "broken" deliberately treats a missing stop as acceptable, on the grounds that an account-level fallback can supply one — the comment in the code says so. The parse is therefore classed as fine, the AI is never asked, and the trade carries on.
- **How:** treat two conditions as broken and hand them to the AI — the message contains a stop loss but the parser returned none, and a take-profit that cannot be a real price.
- **Where:** `worker/src/signalExecutionEligibility.ts` (line 112), called from `worker/src/userListener.ts:2654`.
- **Outcome:** the AI is asked about exactly the cases it was built for.

#### 10d. Withhold the order honestly

- **What:** when a signal is withheld for having no stop, the customer is told *"SL not given — set predefined SL pips in broker configuration"*.
- **Why it is wrong:** two of the three signals we dropped **did** contain a stop — we simply could not read it. The message blames the customer for our parser.
- **Why it is incomplete:** for accounts that already have a fallback stop configured, no such block exists at all — the trade goes out carrying a stop nobody chose.
- **How:** rewrite the message to distinguish *"we could not read it"* from *"there is none"*, and decide whether a fallback stop should still let the trade through.
- **Where:** `worker/src/brokerTradeError.ts` line 57, `worker/src/tradeExecutor/entryPrepareMissingSl.ts`, and the message text held in 14 files across `src/i18n/locales/` and `src/i18n/channelWorker/` — two separate language trees, both need it.
- **Outcome:** an accurate message, and no unprotected trade.

#### 10e. Prove it

- **What:** replay the 31 real signals from that channel through the changed parser.
- **How:** the `replay-parse` diagnostic.
- **When:** before this work is called done.
- **Outcome:** 8 broken parses become 0, and the 23 that already worked still work.

### 11. Tell the customers what changed

- **What:** a short notice, in 10 languages, explaining that trades now close at the take-profit they selected and that stops no longer shift after opening.
- **Why:** the behaviour they see will change — for the better — and an unexplained change reads as a regression.
- **How:** one short translated message, shipped with the fix.
- **When:** with the release.
- **Where:** the frontend language files.
- **Outcome:** customers understand it; support gets fewer tickets.

### 12. Build order

- **What:** the fixes (7–9), then the parser (10), then the message (11), released together as **one** worker update, tested on staging first.
- **Why:** one release keeps every behaviour change in a single reviewable, reversible step; staging protects real money.
- **How:** build on the staging branch, run the full test suites, deploy to staging, watch it, then move to production.
- **When:** once 7–11 are written and reviewed.
- **Where:** staging branch → production branch.
- **Outcome:** a single tested release instead of four risky ones.

---

**Decisions:**

- (a) **Closed 2026-10-08** — the stop loss keeps re-measuring from the fill. It will be recorded and shown rather than changed to behave differently.
- (b) **Still open** — when to run the log fix above (it pauses trading for about 5 seconds). Also still open: whether to keep the 50 MB × 3 cap, raise it to 200 MB × 10, or add the full 30-day daily archive.
