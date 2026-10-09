# MTAPI rollout plan — the focused path

**Status:** planning. Written 2026-09-26.
**Companion documents:** `docs/mtapi-migration-plan.md` (design and phases),
`docs/mtapi-progress.md` (running log, local only), `docs/mtapi-credentials.md`
(secret reference).

This document is the execution plan for moving customers from FxSocket to MTAPI.
It assumes the reader has already read §6 of the migration plan. It is written in
plain professional English first, with the technical detail underneath each
section.

---

## 1. The user-facing experience

### Plain English

The product already has a flow for this exact situation, and customers already
know it. When a broker connection breaks today, the customer sees a banner on
their dashboard, a **Reconnect** button, and a dialog asking for their MetaTrader
account password. There is an optional "remember password for automatic
reconnect" checkbox, and once it succeeds the account shows "Auto-reconnect
enabled".

The migration reuses that flow. The customer never sees the words MTAPI or
FxSocket, never learns that two connection systems exist, and never has to make
a technical choice.

What the customer experiences:

1. A banner appears on their dashboard:
   > "We've updated how TScopier connects to your broker. Please reconnect your
   > account to keep copying trades."
2. They click **Reconnect**. Their account number and broker server are already
   filled in; only the password is asked for.
3. They type the password. It is stored encrypted.
4. The account reconnects. The banner disappears. Everything looks exactly as it
   did before.

Behind that one click we close the old connection, change the account over, and
sign in through the new route. Their trade history, channel settings, open
positions and subscription slot are untouched — it is the same account record
the whole time.

Two properties make this genuinely low-disruption:

- **Nothing happens until they click.** No account moves without its owner
  acting.
- **Reversing needs no further action from them.** Once we hold their encrypted
  password, we can switch an account back without asking again.

The only real cost to a customer is a brief pause while the account reconnects.
A signal that lands inside that pause is not copied for that account; it can be
retried by hand from the Activities page. That makes a short pause the single
most important engineering target.

### Agreed experience (decided 2026-09-29)

The prompt is **one modal with two stages**, shown at app level rather than
tied to the dashboard:

1. **Trigger.** The moment they are inside the app and logged in, if any
   account needs reconnecting. It does not depend on which page they are on, so
   it covers both a fresh sign-in and people who were already signed in when
   the wave hit. It shows regardless of how old the problem is.
2. **Stage 1 — information.** The modal shows the account details (platform
   logo, label, account number, broker server), a short plain-English
   explanation that we have updated how we connect to the broker, and a
   **Reconnect** button.
3. **Stage 2 — password.** Clicking Reconnect swaps the same modal to the
   password field, with the account details still visible above it. Nothing is
   sent until they press Reconnect.
4. **No dismissal (decided 2026-09-30).** The modal cannot be closed while an
   account needs reconnecting — no close button, no Escape, no backdrop click,
   no Cancel — and it stays until the account reconnects. *Back* from the
   password stage to the details stage is navigation, not dismissal, and remains
   available. A dialog the customer opens themselves (an ordinary session
   expiry) is still closable. The dashboard banner remains the persistent
   fallback while any account is unresolved.
5. **Several affected accounts.** One modal handles them one at a time; the
   account details change in place when a reconnect completes. Never a queue of
   popups.
6. **Still open:** whether accounts holding open trades may switch in the first
   production wave (proposal: flat only first, open trades from the second
   wave).

### Technical

- The existing mechanism is `src/context/BrokerAccountsContext.tsx`
  (`reconnectBroker`, `brokersNeedingReconnect`), which renders the banner on
  `src/pages/dashboard/DashboardPage.tsx` and the password dialog
  `src/components/broker/BrokerReconnectPasswordModal.tsx`, driven by
  `src/hooks/useBrokerReconnect.ts`.
- The current dialog copy is `reconnectPasswordTitle: 'Broker session expired'`
  in `src/i18n/locales/en.ts`. The migration needs a **second** copy variant —
  an honest "we have updated how we connect, please reconnect" message — rather
  than claiming a session expired when it did not.
- The hook passes the account's current provider to
  `fxsocketBroker.reconnect`, which routes to `mtapi-broker` or `fxsocket-broker`
  by provider. The switch feature (Stage 2 below) makes that same call also
  perform the provider change.
- **Signal loss inside the window is real and manual today.** There is no
  automatic re-run of a failed entry; `worker/src/retryActivity.ts` exposes
  `order_send` as a *manual* retry from the Activities page only. This is the
  reason the window must be short (Stage 3).
- **The app-level trigger is already free.** `BrokerReconnectPasswordModal` is
  rendered once by `src/context/BrokerAccountsContext.tsx` and portalled to
  `document.body`, so it sits above every page. What is missing is an effect
  that opens it whenever the user is authenticated and `brokersNeedingReconnect`
  is non-empty — today it only opens after a Reconnect click.
- **Two stages need a stage state** in the modal (`'details' | 'password'`),
  with the account-detail card rendered in both. Stage 1 has no password field;
  Reconnect advances to stage 2. Cancel or back returns to stage 1 without
  touching the account.
- **No dismissal state.** The prompt is derived from `brokersNeedingReconnect`,
  so it opens, stays open, and disappears when the account is resolved. Nothing
  is stored, so there is no suppression to reset and no per-session bookkeeping.
  The dialog hides itself while a reconnect is already in flight so it never
  falls back to stage 1 mid-attempt.
- **Multi-account** means a queue inside the one modal: iterate
  `brokersNeedingReconnect`, show the current account's details, advance to the
  next on success, close when the list is empty.
- **Blocking is accepted (decided 2026-09-30).** The automatic prompt blocks
  the app until the account reconnects: an unresolved account cannot copy
  anything, and a closable prompt was being ignored. The accepted risk is that a
  customer whose broker or bridge is genuinely unreachable cannot reach settings
  or support until it resolves. Watch this during staging testing; if it bites,
  add an escape hatch (a support link, or a timed release after repeated
  failures) rather than restoring free dismissal.

---

## 2. The critical path

| # | Stage | Why it matters | Blocking? |
|---|-------|----------------|-----------|
| 1 | **Catch up the branch** — merge the upstream commits (see count below), run the full check suite | Shipping code that is behind production silently drops recent bugfixes | **Yes — hard prerequisite** |
| 2 | **Build the switch (Phase 3.5)** — allow an FxSocket record through the MTAPI path, close the old connection first, flip the record, keep it the same record | Nothing can move until this exists | **Yes** |
| 3 | **Make the switch fast** — a newly switched account is currently only picked up by a background scan that runs every 4 minutes; add an immediate reaction so it connects in seconds | A four-minute dead account feels broken; seconds feels like a normal reconnect | **Yes — for the experience to feel natural** |
| 4 | **Security gate** — staging has none of the four required secret settings, and a missing encryption key makes a password silently stored in plain text; make that a hard error, close the open password-in-logs incident, commit the log-redactor control (currently untracked) | The first account connected on staging today would store an unprotected password | **Yes** |
| 5 | **Prove it behaves the same** — the 16 behavioural scenarios and the 12-step rollback test with open positions, recorded | This is what protects real money | **Yes** |
| 6 | **Staging** — database upgrades first, then code, then verify nothing moved, then switch the demo account and one or two volunteers | Proves deployments are harmless while customers are connected | — |
| 7 | **Production in waves** — settings, then database, then code, then our test account, then a handful of willing customers, then everyone active on MT5 | Keeps the blast radius small and reversible | — |
| 8 | **MT4 last** — the 12 active MT4 accounts stay on FxSocket until the MT4 safety strategy is proven (see §5) | MT4 has no idempotent order endpoints | — |
| 9 | **Close out** — update the `AGENTS.md` staging rule, write the changelog entry with both plain-English and technical halves, close the incident | Keeps the record straight | — |

### Production wave detail (stage 7)

| Wave | Who | Starts when | Holds until |
|------|-----|-------------|-------------|
| 7a | Nobody — settings, database, code only | Stage 6 exit passed | Smoke test clean: existing FxSocket accounts unchanged |
| 7b | Our own test account | Smoke clean | One full trading session with no provider-related failures |
| 7c | A handful of willing customers, flat accounts only | 7b clean | One week with no rollback trigger |
| 7d | Broad invitation to all active MT5 accounts | 7c stable | Steady state |
| 7e | Accounts with open trades allowed | 7d stable | — |

**Stop conditions for any wave — revert immediately:** a duplicate position, an
open trade left unmanaged, a switch that does not complete, or a rise in failed
copies that cannot be explained.

**Rollback:** disconnect MTAPI for that one account, set it back to FxSocket,
reconnect with the stored password. One account at a time, no deployment needed.

### Current figures (measured against production 2026-09-26)

- 191 broker accounts across 114 customers.
- Active: 110 MT5, 12 MT4. The rest are inactive.
- 341 trades open, 106 pending.
- About 90 of the 122 active accounts were flat at the time of measurement.

---

## 3. What is blocking us right now

Four things, in order:

1. **The switch feature does not exist.** Without it, not one account can move.
   This is the real work.
2. **Staging has no secret settings.** Deploying today would store a customer's
   password unprotected, with no error anywhere.
3. **The branch is behind upstream.** It must be caught up before anything
   ships.
4. **The safety tests have never been run or recorded.** We have written that
   they must pass; nobody has evidence that they did.

Everything else — the database upgrades, the deployment, the banners — is
sequencing, not risk.

### Environment state of the four required settings

| Setting | Migration `supmsgcubipmmowrzoub` | Staging `axdcledcyhyvzrnfkwat` | Production `sxkpcovbyaficvtkpsdo` |
|---------|----------------------------------|--------------------------------|-----------------------------------|
| Encryption key | present | **missing** | present |
| Bridge address | present | **missing** | **missing** |
| Bridge API key | present | **missing** | **missing** |
| Internal token | present | **missing** | **missing** |

The worker side of these cannot be read through the API and must be confirmed in
the Railway dashboard. Edge and worker must hold the **same** encryption key
inside each environment, or session recovery fails silently.

---

## 4. Open decisions

These are proposals, not decisions. They need a call before Stage 2 starts.

1. **Should an account with open trades be allowed to switch?** Allowing it is
   what the safety tests exist to prove, and avoids active traders never
   switching. Restricting early waves to flat accounts is safer.
   *Proposal:* flat only for the first production wave, open trades allowed from
   the second.
2. **Should we build an automatic re-run of a signal that lands inside the
   switch window?** It closes the only real customer-visible risk, but it is an
   extra feature to build and review.
   *Proposal:* make the window under 30 seconds first; add automatic re-run only
   if missed copies appear in practice.
3. **Where do we start?** Stage 1 (catch up the branch) and Stage 2 (build the
   switch) are independent and can both start immediately.
4. **Scope of this rollout: MT5 only, or MT4 included?** See §5.

---

## 5. MT4 readiness (assessed 2026-09-28)

### Plain English

MT4 is closer than we previously thought. When we checked the MT4 specification
line by line, most of the earlier fears turned out to be unfounded, and on
2026-09-28 we proved it against a real demo MT4 account: we signed in, read
prices and account details, opened a small position, closed half of it, closed
the rest, and read the trade history. All of it worked. The trade operations
that protect us from placing the same order twice do exist for MT4, and signing
in with a broker's server name works as we already send it.

Two things came out of that test. First, when only part of a position is closed
on MT4, the leftover half is given a **new ticket number**, while our system
remembers the original number — so our trade management would lose track of the
position after a partial close. That needs a design decision before any MT4
account is moved, and it is the main thing outstanding. Second, one history
endpoint simply does not work on MT4, so we switched that view to use the
closed-order history instead, which does work.

None of this blocks the MT5 rollout — MT5 is still the first track, and nothing
done here changes its behaviour.

### Technical — the specification is now captured

| Item | State |
|------|-------|
| MT4 specification | `.firecrawl/mtapi-mt4-swagger-2026.09.28.json` — OpenAPI, 91 endpoints, service version `v2026.09.10-19.05` |
| MT5 specification | `.firecrawl/mtapi-mt5-swagger-v2026.09.07.json` (already present) |
| Live verification | every endpoint below was probed directly against `mt4.mtapi.io` on 2026-09-28 with a deliberately invalid session token, which makes a missing endpoint return `404` and a present one return `201` with a "client not found" message |

Live probe results for the endpoints our code uses:

| Endpoint | MT4 | Notes |
|----------|-----|-------|
| `ConnectEx` | present | accepts `server=<name>`; a bogus name returns `Server not found: x`, which proves server-name resolution works |
| `Connect` | present | the `host` + `port` form, for cases where the server name is unknown |
| `OrderSendSafe`, `OrderModifySafe`, `OrderCloseSafe` | present | the specification describes the same lost-confirmation protection as MT5 |
| `OrderHistoryPagination`, `OrderHistory`, `ClosedOrders`, `OpenedOrders`, `AccountSummary`, `ConnectionStatus`, `SymbolParams` | present | compatible with our calls |
| `Quote` | present | this is the MT4 price endpoint |
| `GetQuote` | **absent (404)** | MT5 only |
| `Symbols` | present | the published specification omits it, but the running service has it — the specification is incomplete here |
| `SymbolList` | present | alternative name, also available |
| `DisconnectOrphans` | **absent** | MT5 only, and even on MT5 it needs an admin key |

### Technical — corrections to the 2026-09-26 assessment

| Earlier claim | Verified position |
|---------------|-------------------|
| MT4 sign-in requires `host` + `port`, so a stored server name such as `Exness-MT5Trial9` cannot be used | Only the `Connect` method needs `host` + `port`. `ConnectEx` takes a server name and resolves it — our provisioning path already uses `ConnectEx` |
| MT4 has no idempotent write endpoints, so Gate 3's query-and-match strategy must be built first | The three `Safe` endpoints exist on MT4 and document the same protection. Gate 3's custom recovery strategy is no longer needed for MT4 |
| The MT4 image has not been re-tagged in roughly 16 months | The numbered tags stop at 2025-05-27, but the `latest` tag was pushed **2026-09-10**, matching the current specification version. The image is current |
| No MT4 specification captured | Captured (table above) |
| Timeout retries disabled for MT4 order sends as the only safety measure | Kept as it is for now. The other two write operations (modify, close) always retried, and now do so against the idempotent endpoints, which is correct. For order sends, the code deliberately never retries a bridge timeout because a lost acknowledgement may mean the order did open; enabling retries there depends on proving the `Safe` endpoint really does locate an already-placed order, which has not been proven live |

### Technical — changes made in this work package

| File | Change |
|------|--------|
| `worker/src/mtapiProvider.ts` | price reads use `Quote` on MT4 and `GetQuote` on MT5; all three write operations now use the `Safe` endpoints on both platforms; MT4 order-send timeout retries stay disabled (unchanged); `ConnectEx` and `Connect` send `downloadOrderHistory=true` on MT4 |
| `worker/src/mtapiProvider.ts` | partial closes send `lots` (the documented parameter on both platforms) instead of `volume`, which neither specification recognises |
| `supabase/functions/_shared/mtapiClient.ts` | the edge price read picks `Quote` for MT4 the same way the worker does |
| `worker/src/mtapiSessionManager.ts` | orphan cleanup is skipped for MT4, because that service has no bulk cleanup endpoint; it would otherwise log a failure every four minutes |
| `supabase/functions/_shared/mtapiClient.ts` | closed-position history falls back to the closed-order history on MT4, because the dedicated position-history endpoint never succeeds there. Note this is a safety net: the app already skips that source for every MTAPI account (`src/lib/mtTradeTimestamps.ts` calls it only for non-MTAPI providers), so nothing in the UI depends on it today |

### Technical — live verification against a real MT4 account (2026-09-28)

Run against the running MT4 service with a demo Exness account (server
`Exness-Trial10`). Every step below was executed, not inferred:

| Step | Result |
|------|--------|
| Sign-in with a server name plus the history flag | pass — session token issued |
| Account summary | pass — balance, equity, leverage, currency all returned |
| Symbol list | pass — `Symbols` returns the full instrument list (the published specification omits this endpoint, but the service has it) |
| Price read on `Quote` | pass — bid/ask/spread for `EURUSDm` |
| Open a 0.02-lot position on `OrderSendSafe` | pass — filled, ticket returned |
| **Partial close of 0.01 on `OrderCloseSafe` using `lots`** | **pass** — answered `CLOSED_PART`, and exactly 0.01 lots stayed open |
| Close the remainder | pass — `CLOSED_NORMAL`, account flat afterwards |
| `OrderHistory`, `OrderHistoryPagination`, `ClosedOrders` | pass — all returned rows |
| `HistoryPositions` | **fails** — always answers *"Order history not available"*, with or without the sign-in flag, and after waiting 45 seconds |
| `GetQuote` | confirmed absent (404), as the specification says |
| Orphan cleanup endpoint | confirmed absent on MT4 |

Two behaviours discovered during this run that the specification does not
describe:

1. **A partial close on MT4 moves the remainder to a new ticket.** Opening
   0.02 lots as ticket `399314632` and closing 0.01 left 0.01 lots open under a
   *different* ticket (`399314639`) whose comment reads `from #399314632`. Our
   trade management records a ticket and later modifies or closes by that
   ticket, so any code path that performs a partial close on MT4 would be left
   holding a ticket that no longer exists. This needs a design decision before
   MT4 accounts are moved — it is the single most important open item in this
   section. It does not affect the MT5 track.
2. **The status code differs from MT5.** MT4 answers `200` where MT5 answers
   `201` for the same successful calls. Our code checks the body rather than the
   status, so this is harmless, but any test that asserts `201` will fail
   against MT4.

Two of these need calling out:

- **`downloadOrderHistory=true` on MT4 sign-in.** The parameter exists only on
  MT4, so MT5 sign-in is untouched. Testing showed it does **not** unlock the
  position-history endpoint (that endpoint fails either way) and the closed-order
  history works without it. It is kept because the vendor's documented contract
  asks for it on history calls, but it should not be described as a working
  prerequisite, and its cost is unmeasured: if the bridge downloads history
  synchronously, sign-in for an account with a long history could be slower.
  Worth timing during the conformance run.
- **The `lots` change affects MT5 too.** Three call sites do partial closes
  (per-TP partial exits in `worker/src/tradeExecutor/managementExecutor.ts` and
  `worker/src/autoManagementMonitor.ts`). The specification for both platforms
  documents `lots`; the previous code sent `volume`, which neither recognises,
  so a partial close would have closed the whole position. **Proven live on
  2026-09-28**: 0.02 lots opened, 0.01 closed with `lots`, exactly 0.01 left
  open. The same parameter name is documented for MT5, but an MT5 bridge run
  would still be worth doing before the change ships.

### Technical — what is still missing

1. **No MT4 bridge is deployed.** Only the MT5 container runs on the VPS
   (`timurila/mt5rest`). MT4 needs its own container, its own port and its own
   reverse-proxy route.
2. **The MT4 bridge address is not configured anywhere** — not in `.env.example`,
   not in `worker/.env.example`, and not in the migration environment's secrets.
   Without it an MT4 account falls back to the MT5 address and fails.
3. **No full MT4 conformance run has been executed.** A focused live check of
   sign-in, reads, writes and history was run on 2026-09-28 (results above), but
   `docs/mtapi-conformance.md` still contains zero MT4 mentions: the behavioural
   scenarios, error strings, rate-limit measurements and session tests were all
   run against MT5 only.
4. **No MT4 sample data** in the repository (`docs/PROJECT_MEMORY.md` records
   this as a known gap).
5. **No end-to-end MT4 write test inside the project** — the Phase 3 write test
   ran against the MT5 trial container only. The live check above ran outside
   the project, against the vendor's hosted service rather than a container we
   would deploy.
6. **Orphan session cleanup has no MT4 equivalent.** We skip it for now; MT4
   sessions that outlive our records would have to be cleared one at a time
   with the single-session disconnect call.
7. **The partial-close ticket change is not handled anywhere** — see the
   discovery above. This is now the main MT4 design question.
8. **Position history has no MT4-native source.** The dedicated endpoint is
   unusable on MT4, so the edge now substitutes closed-order history behind it.
   This is a safety net rather than a live path: the app already avoids that
   source for all MTAPI accounts, so nothing today would notice either way. The
   underlying decision (MTAPI accounts have no position-history source at all)
   predates this work and applies to MT5 as well.
9. **The `OrderSendSafe` de-duplication guarantee is unproven.** The endpoint's
   documentation says a lost acknowledgement results in the already-placed order
   being returned rather than a second order being sent. Until that is proven
   live, MT4 order sends keep the conservative policy of never retrying a bridge
   timeout (this is unchanged behaviour). Proving it would also let the MT5 side
   of the same question be revisited.

### Technical — trial container availability (corrected 2026-09-28)

| Image | Size | Newest numbered tag | `latest` tag pushed |
|-------|------|--------------------|--------------------|
| `timurila/mt4rest` | 91.7 MB | 25.05.27 | **2026-09-10** |
| `mtapiio/mt4rest` | 90.0 MB | 25.04.09 | — |
| `timurila/mt5rest` (currently deployed) | 92.0 MB | 26.09.10 | 2026-09-10 |

- Separate program from the MT5 one: own port, own reverse-proxy entry.
- Like MT5, resuming a session after a restart needs a MongoDB component we do
  not have — the same limitation already hit on MT5.
- The Docker daemon is not running on this development machine, so the container
  has not been started locally yet.

### Technical — the MT4 work package (revised)

1. ~~Capture the MT4 specification~~ **done** (2026-09-28).
2. ~~Reconcile the code with the MT4 specification~~ **done** — price endpoint,
   sign-in history flag, `Safe` write endpoints, orphan cleanup skip, `lots`,
   position-history fallback.
3. ~~Prove the changes against a real MT4 account~~ **done** (2026-09-28) —
   sign-in, reads, a 0.02-lot order, a 0.01-lot partial close proving `lots`,
   full close, history reads, account confirmed flat afterwards.
4. **Decide how trade management follows a partial close on MT4**, given that
   the remainder moves to a new ticket (discovery 1 above).
5. Deploy the MT4 bridge: container, port, reverse-proxy route, address secret on
   both edge and worker.
6. Full MT4 conformance run against a demo account, extending
   `docs/mtapi-conformance.md`.
7. Run the 16 behavioural scenarios for MT4 specifically.
8. Only then move the 12 active MT4 accounts.

None of this blocks the MT5 rollout. The safest shape remains **MT5 first, MT4 as
a separate later track**, which is what Gate 3 in the migration plan prescribes:
*MT4 accounts stay on FxSocket until this strategy is tested and proven.* The
revised assessment does not change that ordering; it only makes the MT4 track
shorter than it looked on 2026-09-26.
