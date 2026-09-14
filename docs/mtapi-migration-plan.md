# Migration plan: FXSocket to MTAPI (MT5 + MT4)

Date: 2026-09-09 · Status: **Draft for approval** · Owner: TBD

This document is the full plan for moving TScopier's broker execution from
FXSocket to MTAPI. It is written in two voices throughout: a plain-English
explanation of what and why, and the technical detail an engineer needs to
implement and verify it. It is a plan only; no code changes are included here.

---

## 1. Purpose and scope

### Plain English

Today TScopier talks to each customer's MetaTrader (MT) trading account through a
third-party service called FXSocket. We are considering replacing that service
with a different one called MTAPI. Before changing anything, this document lays
out: what FXSocket currently does in our code, how MTAPI works differently, what
we would need to change, the safe step-by-step way to switch, and how we would
test it. A switch like this touches the database, the trading service, several
website screens, and how we store customer MT passwords, so it has to be planned
carefully and rolled out gradually, one account at a time.

### Technical

Migrate the broker-execution provider from FXSocket's hosted SaaS (account-link
model: `POST /v1/accounts` → stable account UUID → per-account REST) to MTAPI's
live-session model (`Connect(login, password, server|host, port)` → token used as
`?id=` on every call), for both MT5 and MT4, behind a new provider seam so the two
coexist and any account can roll back.

Out of scope: MTAPI's Manager APIs (`mng4/mng5`) — those are a separate product
for broker-side administration and are not needed to log into a client trading
account. Telegram/listener behaviour is unaffected.

---

## 2. Current state (audit summary)

### Plain English

Before we plan the switch, we need to know exactly what we have today. We audited
the codebase and checked the live production database to answer: how many broker
accounts exist, what shape is the code in, where FXSocket is referenced, and what
has changed since the database was last reorganised. This section is the ground
truth the rest of the plan builds on.

### Technical

This section is the result of a codebase audit plus a read-only check of the live
production database.

### 2.1 Database (verified against prod 2026-09-09)

We checked the live database and found 172 broker accounts. All of them are
linked to FXSocket. Most are healthy and connected. We have 16 real MT4 accounts
across 11 users that must continue working through the migration. Nothing is
broken today.

- 172 broker accounts, all with a non-empty `fxsocket_account_id`. No legacy
  `metaapi_account_id` values remain and no id collisions exist.
- **145 active** accounts across **87 users**: 129 MT5 (128 connected, 1 error)
  and **16 MT4 (all connected, 11 users)**. MT4 is real and live, including some
  likely-live balances.
- All but ~2 accounts are healthy today (170 connected, 1 error-state row).

### 2.2 Codebase structure

FXSocket is referenced in four separate parts of the codebase, each with its own
copy of the integration logic. The database stores account IDs. The worker (a
long-running Node.js process on Railway) executes trades and runs monitoring
loops. The edge functions (short-lived Deno scripts on Supabase) handle account
linking, trade history, and market data for the website. The frontend (React in
the browser) displays live prices and positions via a direct WebSocket connection.
Every one of these layers must be made provider-aware for the migration to work.

1. **Database / identity.** `broker_accounts.fxsocket_account_id` is the only
   broker key, read by the worker via `worker/src/mtApiByAccount.ts`
   (`brokerSessionId`, `loadPlatformByFxsocketId`) plus the columns `platform`,
   `fxsocket_status`, `connection_status`, `terminal_connected`, `trade_allowed`.
2. **Worker (execution + monitors).** Two coexisting concrete clients behind
   `getFxsocketClient()`:
   - v1 `FxsocketBrokerClient` (`worker/src/fxsocketClient.ts`) — the management /
     poll path (order send/modify/close, opened orders, history, account summary,
     quote, symbol params, status).
   - v2 `FxClient` (`worker/src/engine/fxClient.ts`) — a stricter, idempotent path
     (never blind-retries an ambiguous order send; resolves via an opened-orders
     snapshot). Routed per broker/user by `EXECUTION_ENGINE*` in
     `worker/src/engine/executionMode.ts`.
   - Many monitors poll the broker on fast intervals (400ms–60s) and are woken by
     internal HTTP dispatch and Supabase Realtime database changes; they are not
     fed by broker pushes. The FXSocket websocket layer only proxies market /
     terminal state to the browser dashboard.
   - Closed/positions history is approximated by filtering order history because
     FXSocket has no native closed-positions endpoint.
3. **Edge functions (Deno).** Account linking/status/history live in the
   `fxsocket-broker` Supabase edge function (`supabase/functions/fxsocket-broker/`),
   backed by a separate Deno HTTP client (`supabase/functions/_shared/fxsocketClient.ts`,
   737 lines) and the history mapper `_shared/fxsocketTrades.ts` (518 lines). This is
   a **independent codebase** from the worker — same FXSocket endpoints, different
   language (Deno vs Node), different error handling, different timeouts. The edge
   function also calls FXSocket for market data in `backtest-run` (PriceHistory,
   QuoteTicks, symbols via `_shared/backtest/fxsocketMarketData.ts` and
   `_shared/backtest/resolveBacktestBroker.ts`). Other edge functions that touch
   broker accounts (`force-close-trades`, `retry-signal`, `retry-activity`,
   `signal-override`) delegate to the worker and do not call FXSocket directly, but
   they validate `fxsocket_account_id` existence.
4. **Frontend (React + WebSocket).** The website calls the `fxsocket-broker` edge
   function via `src/lib/fxsocketBroker.ts` (16+ actions). WebSocket streaming
   (`src/lib/fxsocketStream.ts`, `fxsocketStreamNormalize.ts`,
   `fxsocketStreamParse.ts`, `fxsocketLivePositionBook.ts`) connects directly to
   FXSocket's WebSocket endpoint for live prices, positions, account data, and
   terminal state — this is a separate transport layer from the REST edge function.
   The frontend has 33+ references to `fxsocket_account_id` across
   `brokerLink.ts`, `brokerReconnect.ts`, `brokerConnectError.ts`,
   `fxsocketMtStatus.ts`, `bulkConnectBrokers.ts`, and multiple components
   (`ConnectTradingAccountModal`, `BrokerStatusModal`, `BrokerTerminalHealthSync`,
   `PendingBrokerConnectionSync`, `BrokerStatsOverlay`).

Cross-cutting coupling that a provider swap must address:
- FXSocket-specific error-string detection: session-gone / disconnected,
  benign ("order already closed") errors, throttle / retry semantics.
- Benign-error phrase-matching is duplicated as literal regexes in monitors
  (`autoManagementMonitor.ts`, `cweCloseMonitor.ts`, `partialTpMonitor.ts`,
  `trailingStopMonitor.ts`) plus standalone functions in
  `managementExecutor.ts:273-281` (`isUnknownTicketError`,
  `isRetryableBreakevenError`), with a shared helper existing
  (`worker/src/orderModifyBenign.ts`).
- Every order close is centrally audited (`worker/src/orderCloseAudit.ts`), but the
  `source` type union is currently `'fxsocket' | 'fx_v2'` — adding `'mtapi'` is a
  required Phase 1 change or it will cause a compile error in Phase 3.
- MT passwords are **not stored today**. The FXSocket-unify migration
  (`20260616120000_fxsocket_unify_broker_accounts.sql`) dropped
  `mt_password_encrypted`, `auto_reconnect_enabled`, `password_updated_at`, and the
  connect-lock table. Encryption helpers exist but are unused
  (`worker/src/brokerCredentialsCrypto.ts`).

### 2.3 Deployment model

Normally, code changes go to a testing branch first, then to production. This
migration is different: it lives on its own branch (`migration`) so it does not
interfere with regular releases. That branch is currently behind the latest code
and needs to be caught up before anything ships.

- FxSocket is a hosted SaaS (see `docs/fxsocket-integration.md`). TScopier does
  not run the terminals.
- MTAPI is self-hosted Docker on Contabo (Cloud VPS 4, 4 vCPU, 8 GB RAM,
  ~$6.60/mo). The worker stays on Railway. The Docker container runs the MTAPI
  bridge (`timurila/mt5rest` or `mtapiio/mt5rest`) and connects to broker servers
  from the Contabo data center. An nginx reverse proxy sits in front of the Docker
  container on the same VPS, providing TLS termination and shared-secret
  authentication (`X-MTAPI-Key` header). MTAPI itself has no API key — security is
  network-level (nginx auth + Contabo firewall).
- The rest of the project normally deploys worker/edge changes staging-first from
  the `staging` branch (Railway). **This MTAPI migration is an exception: it is
  developed and tested on the `migration` branch, not on `staging`** (see §2.5).
  Every code change must still pass the project's fast checks and the mandatory
  `code-tester` + `code-review` subagent review before sign-off (`AGENTS.md`).

### 2.5 Branch strategy for this migration (documented 2026-09-09)

Plain English: this work lives on the `migration` branch so it does not disturb
the normal `staging`/`dev` flow. The `migration` branch is currently behind the
latest code and needs to be brought up to date (by merging) before the rollout can
use it. This section records that intent; no branch has been changed yet.

Technical state (verified 2026-09-09):

- The current up-to-date integration point is commit `00376fa4`. As of this date
  it is shared by `staging`, `dev`, `origin/staging`, `upstream/dev`, and
  `upstream/staging`.
- The frontend is currently served from `origin/migration`.
- Three `migration` branches exist and diverge from each other, and all are stale
  relative to `00376fa4`:
  - local `migration` = `2b0b5141` (~96 commits behind),
  - `origin/migration` = `b4d57386` (~96 commits behind; contains fork-specific
    work such as "mount product app on migration.tscopier.ai"),
  - `upstream/migration` = `51451bb0` (~86 commits behind; a distinct upstream
    line). `upstream/migration-plans` (`ef4338cf`) is a related branch.

Decision (with the team):

- Use **local `migration` and `upstream/migration`** as the migration branches for
  this work; `origin/migration` is the line currently serving the frontend.
- Before any rollout on the migration branch, **bring it up to date by merging**
  the current tip (`00376fa4`) into it. Merging (not rebasing/resetting) is the
  intended approach so the migration branch keeps its history.
- Not yet done: no merge/rebase was performed at documentation time. This is a
  follow-up action before Phase 1 (see §6).
- Push policy: per `AGENTS.md`, never push to `upstream/*` without explicit
  go-ahead. Confirm authorized remotes/branches for each push during rollout.

### 2.4 Schema drift note (important)

The database migration files and the live database are out of sync. Two columns
that were supposed to be dropped still exist in production and are actively used.
A status column has a constraint that does not match the values the code actually
writes. This drift must be cleaned up before any new migration work begins,
otherwise new changes will compound the problem.

Live prod has `connection_error_kind` and `connection_error_message` columns even
though the migration files say they were dropped; the worker's `fxsocket-broker`
edge still writes them and works. **This must be resolved in Phase 0** (not as a
reminder) — generate a `supabase db diff` against prod, reconcile the drift, and
produce a clean baseline migration before any Phase 1 work. New migrations in
Phase 1 will compound the drift if it is not resolved first.

Additionally, the `fxsocket_status` CHECK constraint
(`connecting/connected/error/disconnected`) does not include `'pending'`, but the
worker writes `fxsocket_status = 'pending'` via `brokerConnectionStatus.ts`. The
unify migration (`20260616120000`) also attempted to insert `'pending'` into this
column during the sandbox merge. This constraint must be reconciled before new
migration work.

---

## 3. How MTAPI differs from FXSocket (doc-verified)

### Plain English

FXSocket and MTAPI do the same job — let our software control a customer's
MetaTrader account — but they work very differently. FXSocket is a managed
service that holds onto terminal sessions for us. MTAPI gives us a live token
that expires when the connection drops, so we have to manage sessions ourselves.
MTAPI also has better trade-history data and built-in duplicate-trade protection
on MT5, but lacks that protection on MT4. The table below shows the differences
that matter for this migration.

### Technical

| Area | FXSocket (today) | MTAPI |
|------|------------------|-------|
| Link model | `POST /v1/accounts` → stable account UUID, terminal hosted cloud-side, persists | `Connect(user,password,server|host,port)` → token = live session |
| Session life | Yours to hold; always up | The bridge holds it; ends on restart/disconnect unless reconnected |
| Deployment | SaaS only | SaaS (`*.mtapi.io`, trial) **or** self-hosted Docker bridge (`mtapiio/mt5rest`) |
| Auth | `X-API-Key` on every call | Token as `?id=`; admin key only for cluster ops |
| Idempotent send | Hand-rolled in v2 `FxClient` | Native `OrderSendSafe/ModifySafe/CloseSafe` on **MT5 only** |
| Trade endpoints | `OrderSend/Modify/Close` | Current MT5 spec: `OrderSendTask/ModifyTask/CloseTask` (+ `*Safe`) |
| History | Closed positions faked by filtering order history | Native `ClosedOrders`, `OrderHistory[Pagination]`, `HistoryPositions` |
| Push | WS only to browser; monitors poll | `OnOrderProfit` / `OnOrderUpdate` websockets |
| Stop-loss modify | One field at a time possible | `OrderModify` **requires** stop-loss and take-profit together |
| `operation` encoding | String | Integer enum (confirmed): 0=Buy, 1=Sell, 2=BuyLimit, 3=SellLimit, 4=BuyStop, 5=SellStop, 6/7/8/100/101=undocumented (Phase 0) |
| MT4 duplicate-safe sends | n/a | **Not available** on MT4 |
| HTTP method | POST with JSON body | **GET with query parameters** (confirmed: all trading/account endpoints are GET; only `ConnectCert`, `DisconnectOrphans`, `DisconnectOrphansCluster`, `LoadServersDat` are POST multipart) |
| Native closed orders | No (faked via OrderHistory) | Yes (`ClosedOrders`, `HistoryPositions`, `HistoryPositionsByCloseTime`) — confirmed |

### 3.1 Key design consequences

### Plain English

These differences create four problems we must solve. First, MTAPI needs
customer passwords to reconnect after a bridge restart, so we have to start
storing them again — we deliberately stopped storing them when we moved to
FXSocket. However, the normal case (worker restart, network drop) uses a token
that the bridge already knows — no password needed. Second, someone has to own
each live session and reconnect it when it drops, which today is nobody's job.
MTAPI provides a `DisconnectOrphans` endpoint that lets us reconcile sessions on
deploy, so we do not need a database lock table. Third, MTAPI's own
documentation is inconsistent about what certain fields mean, so we have to test
everything against a real account before we build against it. Fourth, the
existing FXSocket session lifecycle functions (`keepSessionAlive`,
`ensureConnected`, `connectByToken`) are all no-ops — they do nothing because
FXSocket is a stateless REST service with server-managed terminals. MTAPI has a
real client-managed session lifecycle, so these functions need proper
implementations for MTAPI, not wrappers around the empty FXSocket versions.

### Technical

1. **Two reconnect scenarios with different requirements.** MTAPI's
   `ConnectByToken(id=<token>)` reconnects using the bridge's internal state —
   no password needed. This handles the common case: worker restart, network
   drop, or pod reschedule. Passwords are only needed when the **bridge itself**
   restarts (which clears all sessions), requiring a fresh `Connect(user,
   password, server)`. The plan must distinguish these two paths: token-based
   reconnect as the default, credential-based reconnect as the fallback. This
   reverses the deliberate credential-drop decision from the FxSocket migration
   but only for the bridge-restart case.
2. **Deploy-time session reconciliation via `DisconnectOrphans`.** MTAPI provides
   a POST endpoint that takes a list of known session IDs and disconnects
   everything else (with a `dryRun` preview mode). On worker startup, the worker
   queries the bridge for all active sessions, compares against its database, and
   calls `DisconnectOrphans` to clean up stale sessions. This eliminates the need
   for a database lock table (the plan originally proposed restoring the dropped
   `mt_server_connect_locks`).
3. **`AccountSummary.synced` is a safety gate.** MTAPI's `AccountSummary`
   response includes a `synced` boolean. When `false`, Balance/Equity values are
   unreliable (may be 0) because the terminal is still reconnecting/resyncing.
   All consumers must check `synced` before trusting account data — particularly
   for trade sizing and balance display.
4. **Endpoint names, encodings, and error strings must be pinned against a live
   MTAPI instance before building** (Phase 0). Several are ambiguous or version-
   drifted in MTAPI's own docs. The `operation` enum has 11 values but only 6
   are documented (values 6/7/8/100/101 are uncertain).
5. **FXSocket session functions are vestigial.** `keepSessionAlive` (returns
   `true` unconditionally), `ensureConnected` (voids the id), and
   `connectByToken` (voids the id) are all no-ops in `fxsocketClient.ts`
   because FXSocket terminals are server-managed — the worker holds no client-side
   session state. MTAPI sessions are client-managed and require real
   implementations of these functions (connect, heartbeat, reconnect). The
   `BrokerProvider` interface must define these as required methods; the
   `FxsocketProvider` implementations stay as no-ops; the `MtapiProvider`
   implementations do real work.
6. **Broker-level concurrent login limits.** Both FXSocket and MTAPI connect to
   the same broker account. Some brokers cap concurrent logins. FXSocket handles
   this internally during reconnect (creates-then-deletes). When switching an
   account from FXSocket to MTAPI (or back), the old session should be
   disconnected first to avoid broker-side conflicts. Phase 0 must verify the
   broker's behaviour under concurrent connections and confirm whether
   `Disconnect` must be called on the outgoing provider before `Connect` on the
   incoming one.

---

## 4. Decisions (confirmed with the team)

### Plain English

The team has agreed on five things. We will support both MT5 and MT4 (because
real customers use MT4). We will store passwords again (encrypted) so sessions
can reconnect automatically. We will build a switch that lets us run both FXSocket
and MTAPI at the same time, moving accounts one by one. We will roll out gradually,
starting with read-only checks and ending with real trades. We have not yet decided
whether to host MTAPI ourselves or use their hosted service — that depends on
pricing and is a Phase 0 gate.

### Technical
- **Re-introduce encrypted MT-password storage** so sessions auto-reconnect.
- **Build a broker-provider seam** (FXSocket and MTAPI coexist; per-account
  rollback via a setting).
- **Staged rollout** (read-only → one staging account → one real account →
  gradual). Work is developed and tested on the **`migration` branch**, not on
  `staging` (see §2.5); the migration branch must be brought up to date first.
- **MTAPI hosting model (self-host vs hosted) is still open** and is a Phase 0
  gate because it depends on licensing/pricing.

---

## 5. Migration architecture

### 5.1 Plain English

We build a thin translation layer. Today every program talks to FXSocket directly.
We instead define one common list of operations ("open a trade", "close a trade",
"change a stop", "read open trades", "check status") and write two implementations
of it: one for FXSocket, one for MTAPI. Each customer account gets a setting saying
which one to use (default FXSocket). This lets us run both at once, move accounts
one by one, and flip any account straight back to FXSocket if needed.

### 5.2 Technical shape

**Worker provider seam.**
- Introduce a `BrokerProvider` interface covering the operations actually used:
  session lifecycle (`connect/ensureSession/checkConnect/disconnect`), order
  send/modify/close (+ safe variants on MT5), opened/closed orders, history,
  account summary, quote, symbol params, symbols, and status/connection health.
  Keep the existing normalized types (`OrderSendArgs`, `OrderResult`,
  `AccountSummary`, `SymbolParams`, `MtStatus`). **Add `synced: boolean` to the
  `AccountSummary` type** — when `false`, Balance/Equity are unreliable (may be 0
  because the terminal is still reconnecting). All consumers must check `synced`
  before trusting account data.
- Implement `FxsocketProvider` (wrapping the existing v1 + v2 semantics unchanged)
  and `MtapiProvider`.
- Add a per-account `broker_accounts.provider` setting
  (`'fxsocket' | 'mtapi'`, default `'fxsocket'`) and a resolver
  (`apiForBrokerAccount`) so all callers — entry, management, monitors — pick the
  right provider. **When `provider='mtapi'`, the `EXECUTION_ENGINE` routing is
  bypassed entirely** — the provider resolver returns the MTAPI client directly,
  not through `FxClient` or `FxsocketBrokerClient`. An MTAPI account should never
  be routed to `FxClient`'s idempotent-send path (which calls FXSocket, not MTAPI).
- Normalise broker-error detection into provider-tagged predicates (a single
  source), removing the duplicated literal regexes in the monitors
  (`autoManagementMonitor.ts`, `cweCloseMonitor.ts`, `partialTpMonitor.ts`,
  `trailingStopMonitor.ts`) and standalone functions in `managementExecutor.ts`
  (`isUnknownTicketError`, `isRetryableBreakevenError`) as part of this work.

**Edge-function Deno provider.**
The Supabase edge-function layer has its own independent FXSocket HTTP client
(`supabase/functions/_shared/fxsocketClient.ts`, 737 lines) and history mapper
(`_shared/fxsocketTrades.ts`, 518 lines). This layer must also gain provider
awareness:
- Create a `MtapiDenoClient` in `_shared/` implementing the same REST endpoints
  as the worker's `MtapiProvider` but using Deno's `fetch` and Web Crypto APIs
  (not Node's `undici`). **The worker owns all connection lifecycle.** The edge
  function is a consumer — it reads the persisted session token/ID from the
  database, never calls `Connect`, `ConnectByToken`, or `Disconnect`
  independently. When the session is gone, the edge function calls the worker's
  recovery API, not MTAPI directly. All MTAPI REST calls use GET with query
  parameters (token as `?id=`), not POST with JSON bodies — this is a
  fundamental difference from the FXSocket Deno client which uses POST.
- Route the `fxsocket-broker` edge function's 16+ actions through the provider
  resolver: for `provider='mtapi'` accounts, use `MtapiDenoClient` instead of the
  FXSocket Deno client. This affects `connect`, `reconnect`, `delete`,
  `refresh_summary`, `broker_status`, `opened_orders`, `order_history`,
  `position_history`, `quote`, `symbols`, `symbol_info`, `live_snapshot`, and
  `trades`.
- The `backtest-run` edge function calls FXSocket directly for market data
  (PriceHistory, QuoteTicks, symbols). MTAPI's equivalent endpoints must be
  mapped and an `MtapiMarketDataClient` added to `_shared/backtest/`.
- The `force-close-trades`, `retry-signal`, and `retry-activity` edge functions
  delegate to the worker (no direct FXSocket calls), but they validate
  `fxsocket_account_id` existence — this check must become provider-conditional
  (`fxsocket_account_id` for FXSocket, `mtapi_session_id` or equivalent for
  MTAPI).

**Worker WebSocket stream layer.**
The worker has a complete upstream WebSocket layer that connects to FXSocket and
proxies messages to the browser. This layer is FXSocket-specific and must gain
provider awareness:

- `worker/src/fxsocketWsClient.ts` (297 lines). Direct upstream WebSocket client
  connecting to FXSocket's MT4/MT5 WS API. Has auto-reconnect with exponential
  backoff, health monitoring via `SustainedOutageTracker` (hardcoded to
  `provider: 'fxsocket'`), and reference-counted topic subscription. URL pattern:
  `wss://{host}/mt5/{accountId}/ws?api_key={key}`.
- `worker/src/fxsocketStreamManager.ts` (250 lines). Manages one upstream WS per
  account; fans out to multiple in-process subscribers with reference-counted
  topics. Singleton factory (`getFxsocketStreamManager()`). Convenience methods:
  `subscribePrices()`, `subscribePositions()`, `subscribeAccount()`,
  `subscribeTrades()`, `subscribeTerminal()`.
- `worker/src/brokerStreamProxy.ts` (150 lines). JWT-gated WebSocket proxy:
  browser → worker → FXSocket upstream. Upgrades at `/broker/stream`. Uses
  `fxsocket_account_id` as session ID. Relays `subscribe`/`unsubscribe` frames
  from browser to `streamManager.ensureTopic()`.
- `worker/src/index.ts` wires up the stream proxy — only attached if
  `FXSOCKET_API_KEY` is set.

For MTAPI, either `fxsocketWsClient.ts` must be generalised to a
`brokerWsClient.ts` (provider-parameterised URL, health tracker, and env vars),
or a separate `mtapiWsClient.ts` must be built. The `brokerStreamProxy.ts` must
resolve session ID from the provider-appropriate column (`fxsocket_account_id`
for FXSocket, `mtapi_session_id` for MTAPI). The stream manager and topic
subscription pattern are provider-agnostic and can be reused.

**Frontend WebSocket layer.**
The frontend has a direct WebSocket connection to FXSocket (`src/lib/fxsocketStream.ts`)
for live prices, positions, account data, and terminal state. This is separate from
the REST edge function and needs its own MTAPI equivalent:
- The frontend connects to the **worker's** `/broker/stream` proxy, not directly
  to FXSocket. This means the frontend WebSocket code is largely
  provider-agnostic — it talks to the worker, and the worker talks to the broker.
  Provider awareness is needed in the worker proxy, not the frontend.
- MTAPI provides `OnQuote`, `OnOrderProfit`, `OnOrderUpdate` websockets — these
  have different topics, message shapes, and subscription protocols than FXSocket's
  `prices`/`positions`/`account`/`trades`/`terminal` topics.
- `fxsocketStreamNormalize.ts` and `fxsocketStreamParse.ts` contain FXSocket-specific
  message parsing (PascalCase fields, bare position rows, nested deal objects). An
  MTAPI stream normaliser must be built for the different message shapes.
- `fxsocketLivePositionBook.ts` maintains a live position book from WS trade events
  — the update protocol differs between providers.

### 5.3 Design rules (the parts that must be handled carefully)

### Plain English

Seven rules that the implementation must follow. Breaking any of these will cause
runtime failures, security issues, or data corruption. They are not suggestions —
they are constraints derived from how the codebase works today and what MTAPI
requires.

1. **Credentials + live sessions are a designed phase, not a side note.** Restore
   encrypted credential storage for bridge-restart recovery (customers/UI can
   never read the stored value; select revoked from `authenticated`), with a guard
   trigger scoped to `provider='mtapi'` rows. The normal reconnect path uses
   `ConnectByToken` (no password needed); passwords are only needed when the
   bridge itself restarts. Use `DisconnectOrphans` on worker startup to reconcile
   sessions against the database's known session IDs — no database lock table is
   needed.
2. **The provider layer covers the full contract**, not just placing orders: it
   must route the debounced connection-status writer, terminal-health writer, the
   keep-alive/heartbeat (currently a no-op), reconnect-on-boot, and symbol
   pre-warming. Live keep-alive is enabled **only for MTAPI accounts**, never
   globally while FXSocket accounts remain.
3. **Keep each account's identity clean.** MTAPI accounts use new id/credential
   columns; their values must never flow into FXSocket routing
   (`mtApiByAccount.brokerSessionId`). Existing FXSocket accounts keep their
   current IDs.
4. **Centralise benign-error handling** (removes the duplicated monitor regexes
   and standalone functions). All of these sites must be consolidated into a
   single provider-tagged predicate module:
   - `autoManagementMonitor.ts:468` — inline regex
   - `cweCloseMonitor.ts:357` — inline regex
   - `partialTpMonitor.ts:96` — `isPartialTpBenignBrokerError()`
   - `trailingStopMonitor.ts:286-287` — inline regex + `isBenignOrderModifyError()`
   - `managementExecutor.ts:273-281` — standalone `isUnknownTicketError()` and
     `isRetryableBreakevenError()`
   The shared helper `orderModifyBenign.ts` already exists but is not used by all
   sites. The migration should make it the single source and delete the
   duplicates.
5. **MT4 has its own track** because MTAPI MT4 lacks the duplicate-safe send
   family; MT4 accounts need the stricter self-checking path or an explicit
   per-account decision.
6. **Execution safety sits above the provider layer.** The TScopier execution
   safety layer (execution claim, duplicate dispatch protection,
   already-materialized check, ambiguous order handling, broker snapshot
   verification, adopt existing fill) must run for every provider, including
   MTAPI. These are not FxSocket features — they are TScopier rules. MTAPI's
   `*Safe` endpoints add a second safety layer, not replace the first. When
   `provider='mtapi'`, the provider resolver returns the MTAPI client, but all
   calls still pass through the execution safety layer above it.
7. **The edge-function Deno layer is an independent codebase** from the worker.
   It needs its own `MtapiDenoClient` (not a re-export of the Node client) and
   its own test suite. The provider seam in the edge function mirrors the worker's
   but is implemented separately. **The worker owns all session lifecycle** (connect,
   disconnect, reconnect, orphan cleanup). The edge function is a consumer — it
   reads the persisted session from the database and never independently manages
   MTAPI sessions. This avoids session races between the two runtimes.

---

## 6. Rollout steps

### Plain English

We do not switch everyone over at once. Instead, we move through six phases.
Phase 0 is research: stand up MTAPI, connect test accounts, and pin down exactly
how it behaves. Phase 1 is plumbing: build the switch mechanism without changing
any behaviour. Phase 2 is shadow mode: read from MTAPI alongside FXSocket and
compare the results. Phase 2.5 is frontend readiness: make the website
provider-aware so it can display and manage MTAPI accounts. Phase 3 is writes on
one test account: actually place trades through MTAPI. Phase 4 is real accounts:
move one small account, watch it closely, then expand. At any point, any account
can be flipped back to FXSocket instantly.

> Branch/deploy note: all code for this migration is developed on the
> `migration` branch and deployed to its environment for testing; it is not
> deployed via the normal `staging` branch flow. Bring the migration branch up to
> date (merge current tip) before Phase 1, per §2.5. "Staging account" below means
> a low-risk test broker account used during rollout, independent of the git
> branch the code ships on.

1. **Phase 0 — Conformance spike + hosting gate + schema baseline.**
   - **Open a real demo account with a broker** (ICMarkets, Pepperstone, Exness,
     or the same broker TScopier uses in production). The MTAPI readme's demo
     credentials (62333850) are expired and do not work on either hosted or
     Docker. The `Search` endpoint works to find broker servers, but connecting
     requires valid credentials from a live demo account. This is a prerequisite
     before any testing can begin.
   - Stand up MTAPI: either the **hosted trial** (`mt5.mtapi.io`, 14-day full
     trial, demo credentials in the readme) or the **Docker bridge**
     (`docker run -d --restart always --name mt5rest -p 5000:80 timurila/mt5rest`,
     unlimited, no payment). Connect a demo MT5 and demo MT4 account.
   - Pin exact request/response JSON, the real benign / session-gone / timeout /
     throttle error strings, the `operation` and stop-loss encodings, the
     websocket topology (`/events` vs `/OnOrderProfit`), how long sessions last,
     and whether a bridge restart drops sessions.
   - **Measure MTAPI rate limits and HTTP characteristics:** request latency
     under load, per-endpoint throttle limits, whether 429 responses include
     retry-after headers, maximum concurrent connections, and whether WebSocket
     push reduces the need for REST polling. These measurements determine whether
     the existing `tradeOpGate` (3 concurrent ops/account), `checkConnectGlobalMinMs`
     (25s pacing), and `undici.Agent` pool sizing (64 connections) are appropriate
     for MTAPI or need adjustment.
   - Confirm MT5 order-profit / order-update subscription behaviour and the
     GetQuote response shape.
   - **Produce a concrete `operation` enum mapping** (e.g. `0 = Buy, 1 = Sell,
     2 = BuyLimit, ...`) and store it in a shared constant (`MtapiOperation`
     type), not scattered inline values. The MTAPI spec drifts between integer
     enums and string names — Phase 0 pins the real encoding.
    - Resolve MTAPI hosting + licensing (self-host vs hosted); ~145 concurrent
      sessions is the sizing input. **`MaxSessions` is deterministic per account
      (conformance proved: each account gets exactly 1 session).** The hosted
      trial does not allow multi-session — setting it to 1 is the only option.
      Self-hosted Docker allows `MaxSessions >= 150` (configurable in server
      settings). Handle `MAX_SESSIONS_REACHED` (0x10016) in the error classifier.
      Pricing (from mtapi.io shop): Cloud 100 accounts = $500/month, Cloud 500
      accounts = $1,500/month, On-Premise = $1,000/month. The Docker trial is
      free and unlimited for testing; a paid plan is only needed for production.
      **Decision (2026-09-14): self-hosted Docker on Contabo.** Cloud VPS 4
      (4 vCPU, 8 GB RAM, $6.60/mo) is sufficient for the MTAPI bridge. The
      worker stays on Railway. An nginx reverse proxy provides TLS + shared-secret
      auth (`X-MTAPI-Key` header). MTAPI has no built-in API key — security is
      network-level (nginx + firewall). Total hosting cost: ~$7/mo (Contabo) +
      existing Railway cost, vs ~$85-100/mo if MTAPI were also on Railway.
   - **Test `ConnectByToken` reconnect:** connect via `Connect`, persist the token,
     restart the worker (not the bridge), reconnect via `ConnectByToken` — verify
     the session is re-established without re-entering the password.
   - **Test broker concurrent-login behaviour:** connect the same demo account via
     FXSocket and MTAPI simultaneously (or in quick succession) and observe whether
     the broker rejects the second connection, kicks the first, or allows both.
     This determines whether provider switching requires an explicit disconnect on
     the outgoing provider first.
   - **Resolve schema drift** (§2.4): run `supabase db diff` against prod,
     reconcile `connection_error_kind`/`connection_error_message` columns that
     exist in live but are marked dropped in migrations, fix the `fxsocket_status`
     CHECK constraint (does not include `'pending'`), and produce a clean baseline
     migration before Phase 1.
   - Deliverable: a conformance note appended to this plan or a sibling doc,
     plus a clean schema baseline migration.
2. **Phase 1 — Seam, no behaviour change.**
   - Add the `BrokerProvider` interface, wrap existing FXSocket behind
      `FxsocketProvider`, add the `provider` column (default `fxsocket`), route all
      calls through the resolver. Deploy from the migration branch; confirm
      identical behaviour.
3. **Phase 2 — MTAPI reads on a demo account.**
   - Implement `MtapiProvider` for reads on a staging demo account. **Shadow mode
     (running both providers simultaneously on the same account) is not possible**
     because brokers only allow one connection per account — connecting MTAPI would
     kick FXSocket off, and vice versa. Instead, test MTAPI on a separate demo
     account: connect MTAPI, verify reads (quotes, positions, account summary,
     order history), then disconnect. Re-introduce encrypted-credential storage
     here (needed for bridge-restart recovery). Implement startup session
     reconciliation via `DisconnectOrphans`.
4. **Phase 2.5 — Frontend provider awareness.**
   - Make the website provider-aware before enabling writes. The frontend connects
     to the worker's `/broker/stream` proxy (not directly to FXSocket), so the
     frontend WebSocket code is largely provider-agnostic — the provider routing
     happens in the worker. Changes needed: make `brokerLink.ts`
     provider-conditional (check `fxsocket_account_id` for FXSocket,
     `mtapi_session_id` for MTAPI), update `brokerReconnect.ts` to handle MTAPI
     status fields, update `bulkConnectBrokers.ts` for the MTAPI connect flow
     (which requires encrypted password storage, not just an FXSocket link), and
     verify the `stream_ticket` action in the edge function returns the correct
     worker proxy URL for MTAPI accounts.
5. **Phase 3 — MTAPI writes on one staging account.**
   - Enable safe open/close/modify (MT5) and the stricter path (MT4). Verify no
     duplicate trades; verify break-even, partial closes, trailing stops, and
     management actions.
6. **Phase 4 — per-account cutover.**
   - Move one small real account behind `provider='mtapi'`; watch trade logs,
     connection status, and reconciliation closely; expand gradually. Rollback at
     any time = set that account back to `fxsocket`.

Every phase is its own change and must pass the project's fast checks and the
mandatory `code-tester` + `code-review` subagent review before sign-off.

---

## 7. Endpoint mapping (FXSocket → MTAPI)

### Plain English

Every operation we currently send to FXSocket has an equivalent on MTAPI, but the
names and shapes are different. This table maps each FXSocket endpoint to its MTAPI
counterpart. Several of these must be confirmed against a live MTAPI account in
Phase 0 because the documentation is inconsistent.

### Technical

> Names reflect the current MTAPI MT5 spec (v2026.09.07). Confirm in Phase 0.
> All MTAPI endpoints use **GET** with query parameters (token as `?id=`).

| FXSocket (today) | MTAPI MT5 equivalent | HTTP | Notes |
|------------------|----------------------|------|-------|
| `POST /v1/accounts` (link) | `GET /ConnectEx` (user, password, **server**) → token | GET | Preferred — uses server name. `GET /Connect` (host/port) is fallback |
| (no session keepalive needed) | `GET /ConnectByToken` (id=token) → token | GET | **Reconnect without password** — bridge stores connection details |
| (no session keepalive needed) | `GET /CheckConnect` / `GET /ConnectionStatus` | GET | Check connection state |
| (no session keepalive needed) | `GET /Disconnect` | GET | Disconnect from account |
| (no equivalent) | `GET /ConnectionStatusAll` | GET | Status of all active connections (admin key) |
| (no equivalent) | `POST /DisconnectOrphans` | POST | **Takes known session IDs, disconnects everything else. dryRun mode. Replaces DB lock table.** |
| `orderSend` | `GET /OrderSendSafe` (MT5 only) | GET | Native idempotent send |
| `orderSend` | `GET /OrderSendTask` | GET | Non-idempotent send |
| `orderModify` | `GET /OrderModifySafe` (MT5 only) | GET | **SL+TP can be modified individually.** Sending only one field clears the other to 0. |
| `orderModify` | `GET /OrderModifyTask` | GET | Same as above. |
| `orderClose` | `GET /OrderCloseSafe` (MT5 only) | GET | Native idempotent close |
| `orderClose` | `GET /OrderCloseTask` | GET | Non-idempotent close |
| (no equivalent) | `GET /OrderCancelTask` | GET | Cancel pending order |
| (no equivalent) | `GET /OrderCloseByTask` | GET | Close-by (hedging accounts only) |
| `openedOrders` | `GET /OpenedOrders` / `GET /OpenedOrder` (by ticket) | GET | |
| closed/history (faked) | `GET /ClosedOrders` | GET | **Native closed orders** (last 100 in session) |
| closed/history (faked) | `GET /HistoryPositions` | GET | Position history with caching |
| closed/history (faked) | `GET /HistoryPositionsByCloseTime` | GET | Position history by close time range |
| `orderHistory` | `GET /OrderHistory` / `GET /OrderHistoryPagination` | GET | Pagination for large histories |
| `accountSummary` | `GET /AccountSummary` | GET | Includes `synced` boolean — check before trusting |
| (no equivalent) | `GET /AccountDetails` | GET | Server name, timezone, company, group, leverage |
| `quote` | `GET /GetQuote` (msNotOlder) | GET | |
| `symbols` / `symbolParams` | `GET /Symbols` / `GET /SymbolParams` / `GET /SymbolList` | GET | |
| `mtStatus` / `/status` | `GET /ConnectionStatus` | GET | |
| (no equivalent) | `GET /RequiredMargin` | GET | Margin calculation |
| (no equivalent) | `GET /TradeStats` | GET | Trading statistics |
| (no equivalent) | `GET /EquityHistory` | GET | Equity curve data |
| (no equivalent) | `GET /ChangePassword` | GET | Changes MT password, disconnects session |
| WS stream (browser proxy) | `GET /events` + `GET /Subscribe` | GET | Subscribe first, then receive on `/events` |
| WS stream | `GET /OnOrderProfit` | GET | **Per-order profit + full account snapshot** on every quote |
| WS stream | `GET /OnOrderUpdate` | GET | All trading activity (opens, closes, modifies) |
| WS stream | `GET /OnQuote` | GET | Real-time bid/ask quotes |
| WS stream | `GET /OnMarketWatch` | GET | Market watch updates |
| WS stream | `GET /OnOpenedOrdersTickets` | GET | Periodic ticket list (configurable interval) |
| WS stream | `GET /OnOpenedOrdersTicketsProfit` | GET | Periodic ticket+profit pairs |

MT4 client REST (`mt4.mtapi.io`) mirrors a subset and lacks the `*Safe` family
and some history endpoints.

Conformance items to pin in Phase 0:
- `operation` enum: **confirmed** from swagger spec v2026.09.07. Values 0–5 documented
  (0=Buy, 1=Sell, 2=BuyLimit, 3=SellLimit, 4=BuyStop, 5=SellStop). Values
  6/7/8/100/101 exist in the enum but lack descriptions — Phase 0 must validate
  each against a live account. Shared type: `MtapiOperation`.
- Which order/trade endpoint names exist on the account in question.
- Reply payload that yields the order ticket.
- `GetQuote` actual response shape (has `ask`/`bid`).
- `OrderModify` SL+TP "required together" behaviour: **confirmed** — both
  `stoploss` and `takeprofit` are `required: true` on both `OrderModifySafe` and
  `OrderModifyTask`. To change only one, pass the unchanged value for the other.
- Websocket topology: how `Subscribe` + `/events` works, and how
  `OnOrderProfit` delivers both per-order profit and account snapshot.
- `TickValue` vs `TickValueWithSize` naming: **both exist** — `GetTickValueMany`
  and `TickValueWithSize` are separate endpoints.
- `'unlink'` equivalent error string (FXSocket matches this in
  `isMtSessionGoneMessage`; confirm MTAPI has a session-drop equivalent).
- `AccountSummary.synced` timing: how long after `Connect` does `synced` flip
  to `true`? **Confirmed field exists** — `synced: boolean` on `AccountSummary`.
- Error code ranges: **confirmed** from swagger — 0–17 (general), 1000–1030
  (connection/login), 2000–2018 (trade execution), 3001–3018 (order state),
  4001–4008 (server), 5001–5008 (internal), 10001–10046 (API-specific),
  65536–65558 (MT5 protocol). No human-readable names in spec — need to map
  against MT5 terminal error codes in Phase 0.
- HTTP methods: **confirmed** — all endpoints are GET except `ConnectCert`
  (POST multipart), `DisconnectOrphans`/`DisconnectOrphansCluster` (POST
  multipart), and `LoadServersDat` (POST multipart).

---

## 8. Schema / settings / UI changes

### Plain English

This section lists every file, table, and screen that needs to change. The
database needs new columns for MTAPI account IDs and encrypted passwords, plus a
new setting on each account saying which provider to use. The worker needs a new
configuration pointing it at MTAPI. The edge functions (which the website calls)
need their own MTAPI client. The frontend needs provider-aware WebSocket
streaming, updated status displays, and modified connect/reconnect flows. Every
change is listed here so nothing is missed during implementation.

### Database (new migration)
- `broker_accounts.provider text NOT NULL DEFAULT 'fxsocket' CHECK (provider IN ('fxsocket','mtapi'))`.
- MTAPI identity + encrypted credential columns (e.g. `mtapi_session_id`,
  `broker_password_encrypted`, `password_updated_at`) — lazy-populate at next
  Connect; nullable so existing FXSocket rows are unaffected.
- Column-level `REVOKE SELECT (broker_password_encrypted) FROM authenticated`
  (model `20260525200000_broker_accounts_client_select_fix.sql`); service-role-only
  reads.
- A guard trigger scoped to `provider='mtapi'` only (re-introduce
  `broker_accounts_guard_credentials` from `20260525180000`, dropped in
  `20260617120000`, but scoped to MTAPI rows only).
- No connect-lock table needed — `DisconnectOrphans` handles deploy-time session
  reconciliation. The worker calls `DisconnectOrphans` on startup with its known
  session IDs to clean up stale sessions from previous deploys.
- Reconcile the existing migration-vs-live drift first (see §2.4) — this is a
  Phase 0 prerequisite, not a Phase 1 reminder.
- **Reconcile `fxsocket_status` CHECK constraint**: either (a) extend to include
  `'pending'`, (b) rename to `broker_session_status` for provider-agnostic use,
  or (c) document that `fxsocket_status` is FXSocket-only and MTAPI accounts use
  `connection_status` exclusively. Option (c) is simplest and recommended for
  Phase 1; option (b) is cleanest long-term.
- **Extend `orderCloseAudit.ts` source type**: add `'mtapi'` to the
  `source: 'fxsocket' | 'fx_v2'` union type. This is a Phase 1 code change
  (required before Phase 3 MTAPI writes, or it will cause a compile error).

### Worker env / settings
- Add `MTAPI_BASE_URL` (per instance) and reuse the credential-encryption key
  (`BROKER_CREDENTIALS_ENCRYPTION_KEY`). FXSocket keys remain for
  `provider='fxsocket'` accounts.
- Per-provider keep-alive/reconnect/status wiring; provider-aware observability
  (reuse the existing `provider` / `platform` Sentry outage tagging).

### Worker WebSocket stream layer
The worker's upstream WebSocket layer is FXSocket-specific and must gain
provider awareness:

- **`worker/src/fxsocketWsClient.ts` (297 lines).** Direct upstream WS client.
  URL pattern, health tracker `provider` field, and env vars
  (`FXSOCKET_BASE_URL`, `FXSOCKET_API_KEY`) are FXSocket-specific. Either
  generalise to a provider-parameterised `brokerWsClient.ts` or build a separate
  `mtapiWsClient.ts` for MTAPI's `OnQuote`/`OnOrderProfit`/`OnOrderUpdate`
  endpoints.
- **`worker/src/fxsocketStreamManager.ts` (250 lines).** Per-account stream
  multiplexer with reference-counted topics. The subscription pattern is
  provider-agnostic; only the env var names and singleton factory need updating.
- **`worker/src/brokerStreamProxy.ts` (150 lines).** JWT-gated WS proxy at
  `/broker/stream`. Currently resolves session ID from `fxsocket_account_id`.
  Must become provider-conditional (`fxsocket_account_id` for FXSocket,
  `mtapi_session_id` for MTAPI).
- **`worker/src/index.ts`** wires up the stream proxy — only attached if
  `FXSOCKET_API_KEY` is set. Must also attach for MTAPI accounts when
  `MTAPI_BASE_URL` is set.

### Edge functions (Deno)
The edge-function layer is an independent codebase (~1500 lines across 6 files)
that must gain provider awareness:

- **`fxsocket-broker/index.ts` (733 lines).** Route all 16+ actions through the
  provider resolver. For `provider='mtapi'` accounts, use `MtapiDenoClient`
  instead of the FXSocket Deno client. Key actions requiring provider routing:
  `connect`, `reconnect`, `delete`, `refresh_summary`, `broker_status`,
  `opened_orders`, `order_history`, `position_history`, `quote`, `symbols`,
  `symbol_info`, `live_snapshot`, `trades`.
- **New `_shared/mtapiDenoClient.ts`.** A Deno-native MTAPI HTTP client
  implementing the same REST endpoints as the worker's `MtapiProvider`. Must use
  Deno's `fetch` and Web Crypto APIs (not Node's `undici`). Needs its own token
  management since Deno edge functions cannot share in-memory state with the
  worker process.
- **New `_shared/mtapiTrades.ts`.** MTAPI-specific history mapping equivalent to
  `fxsocketTrades.ts` — maps `ClosedOrders`/`OrderHistoryPagination`/
  `HistoryPositions` into the `FxsocketBrokerTradeRow` shape (or a renamed
  provider-agnostic type).
- **`backtest-run/index.ts` (374 lines).** Calls FXSocket directly for market
  data (PriceHistory, QuoteTicks, symbols). Needs an MTAPI market-data path:
  new `_shared/backtest/mtapiMarketData.ts` and updates to
  `_shared/backtest/resolveBacktestBroker.ts` to resolve MTAPI-linked brokers.
- **`force-close-trades`.** Delegates to the worker (no direct FXSocket calls)
   but validates `fxsocket_account_id` existence — this check must become
   provider-conditional (`fxsocket_account_id` for FXSocket, `mtapi_session_id`
   or equivalent for MTAPI).
- **`retry-signal`, `retry-activity`.** Delegate to the worker without
   validating `fxsocket_account_id` — no changes needed for provider awareness
   in these functions.
- **`_shared/brokerConnectError.ts` (162 lines).** Error classification is
  FXSocket-specific. MTAPI has different error strings (captured in Phase 0). The
  classifier must be extended with MTAPI-specific patterns or split into
  provider-specific classifiers.
- **`_shared/effectiveBrokerBalance.ts` (49 lines).** Balance computation
  (`balance + credit`) should be provider-agnostic, but verify MTAPI's
  `AccountSummary` response includes the same fields.

### Frontend (React)
- **`fxsocketBroker.ts`** — the gateway for all broker ops from the browser.
  Every method POSTs to the `fxsocket-broker` edge function. Provider awareness
  is handled server-side (the edge function routes to the right Deno client), so
  the frontend API client needs minimal changes — but the action names and
  request shapes may differ for MTAPI accounts (e.g. `connect` needs `server`
  instead of `fxsocket_account_id`).
- **WebSocket streaming** (`fxsocketStream.ts`, `fxsocketStreamNormalize.ts`,
  `fxsocketStreamParse.ts`, `fxsocketLivePositionBook.ts`). These connect
  directly to FXSocket's WebSocket endpoint (not via the edge function). MTAPI
  provides `OnQuote`, `OnOrderProfit`, `OnOrderUpdate` websockets with different
  topics and message shapes. An `mtapiStream.ts` normaliser and parser must be
  built, and `useFxsocketStream.ts` must be provider-aware (choose the right WS
  endpoint and parser per account).
- **`brokerLink.ts`** — `hasFxsocketBrokerSession()` checks `fxsocket_account_id`
  is a UUID. Must become provider-conditional (check `fxsocket_account_id` for
  FXSocket, or `mtapi_session_id` for MTAPI).
- **`brokerReconnect.ts`** — status resolution reads `fxsocket_status`. Must
  handle MTAPI accounts using `connection_status` exclusively (or the renamed
  `broker_session_status`).
- **`brokerConnectError.ts`** — client-side error classification mirrors the edge
  function. Must gain MTAPI-specific patterns.
- **`bulkConnectBrokers.ts`** — CSV multi-account linking defaults to MT5 and calls
  `fxsocketBroker.connect()`. Must handle MTAPI connect flow (which needs
  `password` stored encrypted, not just an FXSocket link).
- **Components needing provider awareness:** `ConnectTradingAccountModal`
  (connect flow differs), `BrokerStatusModal` (7 health checks differ),
  `BrokerTerminalHealthSync` (polling interval may differ),
  `PendingBrokerConnectionSync` (pending states differ),
  `BrokerStatsOverlay` (live WS data source differs).

- **`layeringBrokerCapability.ts`.** The `NativePendingCapability` type defines
  `provider: 'fxsocket' | 'unknown'` (line 13). Must be extended to include
  `'mtapi'`. The provider value is derived from `fxsocket_account_id` presence
  (line 44) — this must become provider-conditional.
- **`mtApiByAccount.ts`.** The `apiForFxsocketAccount` function (line 45)
  unconditionally returns the FXSocket client. For MTAPI accounts, the provider
  resolver (`apiForBrokerAccount`) must bypass this module entirely and return the
  MTAPI client directly.

### Other consumers to inventory / gate
- Backtest broker resolution, `force-close-trades`, `layering-mode-capabilities`,
  `update-layering-settings`, `assistant-chat`, `fxsocket-broker`, worker
  diagnostics (`checkFxsocketAccount`, `liveBrokerE2eCheck`), frontend
  (`fxsocketBroker`, `brokerLink`, `brokerReconnect`, `bulkConnectBrokers`), and
  `docs/fxsocket-integration.md` + `docs/worker-deployment.md`.

---

## 9. Testing plan

### Plain English

Every change must pass the project's existing automated checks (type checking,
linting, tests). On top of that, we add new tests specific to MTAPI: does the
provider switch return the right client, does the MTAPI error classifier match
the right strings, does history mapping produce the same dashboard rows, does
encrypted credential storage round-trip correctly. We then test against a real
MTAPI staging account: do reads match FXSocket, do writes avoid duplicate trades,
does the session survive a restart. Finally, we watch one small real account
closely before expanding.

### Fast checks on every change (per `AGENTS.md`)
- Frontend/edge: `npx tsc -b`, targeted `vitest`/`node:test`, `npm run lint` on
  changed files.
- Worker: `npm --prefix worker run build` + `npm --prefix worker test`.
- Edge functions (Deno): `deno test supabase/functions/_shared/` for the MTAPI
  Deno client, trade mapper, and error classifier. The existing test
  infrastructure (`_shared/fxsocketClient.test.ts`, `_shared/fxsocketTrades.test.ts`)
  proves this is viable.
- Run the mandatory `code-tester` + `code-review` subagents after each change
  phase; a tester `FAIL` or any `CRITICAL`/`HIGH` review finding blocks sign-off.

### New unit tests
- Provider selection (`apiForBrokerAccount` returns the right provider; default
  `fxsocket`).
- `MtapiProvider` request builders (query params, token injection, encoding) and
  response normalisers (ticket/order/quote/summary extraction) — pure helpers.
- **`MtapiDenoClient`** request builders and response normalisers — Deno-native
  tests running under `deno test`.
- MTAPI error classifier (order already closed, session gone, timeout, throttle)
  against strings captured in Phase 0; regression that the inline monitor regexes
  are gone and all sites use the shared predicate.
- History mapping: MTAPI `ClosedOrders` / `OrderHistoryPagination` /
  `HistoryPositions` into the dashboard / trades row shapes (both worker and Deno
  edge-function versions).
- Credential crypto round-trip; verify plaintext never reaches logs or client
  reads.
- `managementExecutor.ts` standalone classifiers (`isUnknownTicketError`,
  `isRetryableBreakevenError`) are removed and all callers use the shared
  predicate — regression test that no standalone FXSocket-specific error
  functions remain.

### Staging integration (one account, `provider='mtapi'`)
- Read parity vs FXSocket (opened orders, summary, quote, history reconciliation).
- Write safety: `OrderSendSafe` duplicate case (deliberately ambiguous reply → no
  double position); `OrderCloseSafe`; `OrderModifySafe`; partial-TP / close-lots;
  break-even and trailing via push; management close; force-close.
- Session lifecycle: worker restart → auto-reconnect via stored creds /
  `ConnectByToken`; broker drop → `CheckConnect` recovery; teardown `Disconnect`;
  no duplicate live session; `MaxSessions` breach behaviour.
- **Edge-function integration:** deploy `fxsocket-broker` to staging and run
  broker-status, opened-orders, history, and trade-listing actions against the
  same staging account. Verify read parity with the worker.
- **WebSocket streaming:** verify MTAPI `OnQuote`/`OnOrderProfit`/`OnOrderUpdate`
  delivery matches the frontend's expected position-book and account-summary
  shapes.

### Live (after staging, one small real account)
- Watch `trade_execution_logs` (pipeline summary, broker timing), duplicate-trade
  count, `connection_status`, monitor idle polls, and the split-deploy duplicate
  checklist already documented in `docs/worker-deployment.md`.

---

## 10. Rollback

### Plain English

If anything goes wrong, we can flip any single account back to FXSocket instantly
by changing one database setting. FXSocket is a stateless REST service — the
worker holds no client-side session state, so switching providers does not
conflict at the worker level. If the whole MTAPI approach fails, we disable the
MTAPI path entirely and everything continues working on FXSocket as before. The
only leftover is encrypted passwords stored in the database, which are harmless
but should be cleaned up eventually.

- Any single account: set `broker_accounts.provider = 'fxsocket'` and redeploy.
  Safe at the worker level because FXSocket is stateless. At the broker level,
  the outgoing MTAPI session must be disconnected first (via MTAPI `Disconnect`)
  before the incoming FXSocket connection is established — the broker only allows
  one connection per account at a time.
- Whole-phase rollback: keep `provider` defaulting to `fxsocket`; disable MTAPI
  env/settings; the FXSocket path remains intact throughout because the seam
  wraps existing behaviour unchanged.
- **Credential cleanup on rollback:** if an account rolls back to FXSocket, the
  stored `broker_password_encrypted` value remains in the database. FXSocket does
  not read it, so it is harmless but represents a lingering security surface. A
  follow-up cleanup migration can nullify stale MTAPI credentials after N days, or
  the rollback script can explicitly null the column. The guard trigger on
  `broker_password_encrypted` remains active regardless.

---

## 11. Risks / open items

### Plain English

Several things are not yet resolved. We do not know the cost of MTAPI or whether
to host it ourselves. We do not know if MTAPI sessions survive a bridge restart
without stored passwords. MTAPI may have speed limits that conflict with our fast
polling intervals. Some brokers limit how many concurrent logins a single account
can have — switching providers while both are active could fail at the broker
level. MT4 lacks the duplicate-trade protection that MT5 has, so we need a
separate safety strategy for those accounts. Storing passwords again reverses a
deliberate security decision and needs its own review. And the migration branch
is significantly behind the latest code and must be caught up before anything
ships.

### Technical
- **Broker single-connection constraint.** Most brokers (including Exness) only
  allow one active connection per account at a time. If FXSocket is connected,
  MTAPI cannot also connect — the broker will reject or kick the existing session.
  This means: (1) shadow mode (comparing both providers simultaneously on the same
  account) is not possible; (2) provider switching requires disconnecting the old
  provider first; (3) testing must be done on separate demo accounts or during
  maintenance windows.
- **MTAPI demo credentials are dead (Phase 0 blocker).** The readme demo account
  (62333850) returns INVALID_ACCOUNT on both hosted and Docker. A real demo
  account from a broker must be opened before any Phase 0 testing can begin.
  The `Search` endpoint works (finds broker servers), but connecting requires
  valid credentials.
- **MTAPI hosting + licensing (open, Phase 0 gate).** ~145 concurrent sessions is
  the sizing input. Docker trial is free for testing; production requires a paid
  plan ($500–$1,500/month cloud, $1,000/month on-premise). Confirm `MaxSessions`
  on the chosen model and set it to >=150.
- **Session survival across bridge restarts**: if sessions drop, encrypted-
  credential auto-reconnect is mandatory, not optional.
- **MTAPI speed limits vs our fast polling**: the push option may be a better fit;
  measure in Phase 0.
- **MT4 duplicate safety** under a provider that lacks safe sends: needs the
  self-checking strategy.
- **Credential re-introduction** reverses a deliberate security decision and must
  be handled with its own design review.
- **Migration branch is stale (hard gate).** Local `migration` /
  `origin/migration` / `upstream/migration` are ~86–96 commits behind the current
  tip `00376fa4`. This is not a reminder — it is a **hard prerequisite** before
  any Phase 1 work. Deploying from a stale branch ships code that lacks recent
  bugfixes, schema migrations, and edge-function changes, silently breaking
  accounts. Additionally, `origin/migration` (currently serving the frontend)
  contains fork-specific work ("mount product app on migration.tscopier.ai") that
  diverges from local `migration`. The catch-up process must reconcile these lines.
  Steps: (1) merge `00376fa4` into local `migration`; (2) resolve conflicts with
  `origin/migration`'s fork-specific changes; (3) deploy and smoke-test from the
  rebased branch before proceeding. Confirm push targets per `AGENTS.md` (never
  push to `upstream/*` without explicit go-ahead).

---

## 12. Decisions still required before implementation

### Plain English

Three things must be settled before any code is written: approval of this plan,
which test and production accounts to use for the phased rollout, and catching
up the migration branch.

### Technical

1. ~~MTAPI hosting + licensing (self-host vs hosted).~~ **Decided (2026-09-14):**
   self-hosted Docker on Contabo (Cloud VPS 4, ~$6.60/mo). See §2.3 and §6.
2. Approval of this plan.
3. Confirm which test/prod accounts to use for the phased rollout.
4. Perform the migration-branch catch-up merge and confirm the deploy branch
   (see §2.5).

---

## 13. References

### Plain English

This is the complete list of files and documents referenced throughout this plan.
An engineer implementing the migration will need to read most of these.

### Technical
- `AGENTS.md` (staging-first, review gates, incident/memory practices)
- Worker: `worker/src/fxsocketClient.ts`, `worker/src/engine/fxClient.ts`,
  `worker/src/engine/executionMode.ts`, `worker/src/mtApiByAccount.ts`,
  `worker/src/orderModifyBenign.ts`, `worker/src/brokerCredentialsCrypto.ts`,
  `worker/src/orderCloseAudit.ts`, `worker/src/engine/fxContract.ts`,
  `worker/src/brokerConnectError.ts`, `worker/src/fxsocketMtStatus.ts`,
  `worker/src/brokerTradeError.ts`, `worker/src/brokerExecutionMode.ts`,
  `worker/src/autoManagementMonitor.ts`, `worker/src/cweCloseMonitor.ts`,
  `worker/src/partialTpMonitor.ts`, `worker/src/trailingStopMonitor.ts`,
  `worker/src/engine/v2ReconcileMonitor.ts`, `worker/src/managementExecutor.ts`,
  `worker/src/fxsocketWsClient.ts`, `worker/src/fxsocketStreamManager.ts`,
  `worker/src/brokerStreamProxy.ts`, `worker/src/layeringBrokerCapability.ts`
- Worker (Phase 1 — new): `worker/src/brokerProvider.ts` (BrokerProvider
  interface + MtPlatform + BrokerProviderName types),
  `worker/src/fxsocketProvider.ts` (FxsocketProvider wrapping FxsocketBrokerClient),
  `worker/src/providerResolver.ts` (apiForBrokerAccount + inferProvider)
- Edge functions: `supabase/functions/fxsocket-broker/index.ts`,
  `supabase/functions/_shared/fxsocketClient.ts`,
  `supabase/functions/_shared/fxsocketTrades.ts`,
  `supabase/functions/_shared/fxsocketMtStatus.ts`,
  `supabase/functions/_shared/fxsocketBsaClient.ts`,
  `supabase/functions/_shared/brokerConnectError.ts`,
  `supabase/functions/_shared/brokerCredentialsCrypto.ts`,
  `supabase/functions/_shared/effectiveBrokerBalance.ts`,
  `supabase/functions/backtest-run/index.ts`,
  `supabase/functions/_shared/backtest/fxsocketMarketData.ts`,
  `supabase/functions/_shared/backtest/resolveBacktestBroker.ts`
- Frontend: `src/lib/fxsocketBroker.ts`, `src/lib/brokerLink.ts`,
  `src/lib/brokerReconnect.ts`, `src/lib/brokerConnectError.ts`,
  `src/lib/fxsocketMtStatus.ts`, `src/lib/fxsocketStream.ts`,
  `src/lib/fxsocketStreamNormalize.ts`, `src/lib/fxsocketStreamParse.ts`,
  `src/lib/fxsocketLivePositionBook.ts`, `src/lib/bulkConnectBrokers.ts`
- Migrations: `20260616120000_fxsocket_unify_broker_accounts.sql`,
  `20260525180000_broker_stored_credentials.sql`,
  `20260525200000_broker_accounts_client_select_fix.sql`,
  `20260613140000_mt_server_connect_lock.sql`,
  `20260617120000_drop_broker_accounts_guard_credentials.sql`,
  `20260805130000_enforce_plan_broker_channel_limits.sql`,
  `20260914120000_add_broker_accounts_provider.sql` (Phase 1 — adds
  `provider` column to `broker_accounts`, default `'fxsocket'`)
- MTAPI docs: `mt5.mtapi.io` / `mt4.mtapi.io` (client REST, swagger + readme)

---

## 14. Safety gates (from Emmanuel's review)

Emmanuel reviewed the migration plan and found five safety gaps. Each gate below
must be satisfied before any real account moves to MTAPI.

### Gate 1 — One session owner

**What Emmanuel said:** Both the worker and the edge functions could independently
try to connect to MTAPI. If both call `Connect` at the same time, one might
disconnect the other's session, or you get duplicate connections.

**What we changed:** The worker owns all connections. Edge functions never call
`Connect`, `ConnectByToken`, or `Disconnect`. They read the saved session from
the database and use it for read operations (quotes, orders, history). When the
session is gone, the edge function asks the worker to recover it — it does not
reconnect on its own.

**How we verify it:** Audit every `Connect`/`Disconnect` call site in the
codebase. Only the worker may call them. Edge functions and the frontend read
the persisted token.

### Gate 2 — Don't throw away the safety net we already built

**What Emmanuel said:** The plan says to bypass TScopier's execution engine when
`provider=mtapi` and call MTAPI directly. But TScopier already has layers of
protection — things like "don't send the same trade twice," "if the broker
response is unclear, query the actual positions before retrying," and "verify the
broker snapshot before acting." These aren't FxSocket features. They're TScopier
rules. They should sit above the provider layer, so whether you're using FxSocket
or MTAPI, the same safety checks run.

**What we changed:** TScopier's execution safety layer stays above the provider
layer for all providers. MTAPI's `*Safe` endpoints add a second safety layer on
top, not replace the first.

```
Signal
  ↓
TScopier safety rules (execution claim, duplicate dispatch,
  already-materialized check, ambiguous order handling, snapshot verification)
  ↓
BrokerProvider
  ├── FxsocketProvider (FxClient v2)
  └── MtapiProvider (*Safe endpoints for MT5, self-checking for MT4)
```

**How we verify it:** Code review confirms no `provider='mtapi'` path skips the
execution safety layer.

### Gate 3 — MT4 is a different problem

**What Emmanuel said:** MTAPI's safe endpoints (`OrderSendSafe`, `OrderModifySafe`,
`OrderCloseSafe`) only exist for MT5. MT4 doesn't have them. But TScopier has 16
live MT4 accounts. Don't treat MT5 readiness as full migration readiness. MT4
needs its own safety strategy — when the broker response is unclear, query open
positions, match them by symbol/direction/lots/time, and only adopt or retry based
on what you find.

**What we added:** A self-checking pattern for MT4:

```
Send order
  ↓
Response clear success?
  ├── yes → persist
  └── ambiguous / timeout
        ↓
      DO NOT resend immediately
        ↓
      Query OpenedOrders
        ↓
      Match: symbol + direction + lots + approximate entry + time window
        ↓
      Match found?
        ├── yes → adopt position (update DB)
        └── no → only then consider retry (with backoff)
```

**Rule:** MT4 accounts stay on FXSocket until this strategy is tested and proven.

**How we verify it:** Test with deliberately ambiguous responses (timeout,
connection drop). Prove: no duplicate positions, no orphaned DB trades.

### Gate 4 — Prove the system behaves the same, not just that the endpoints work

**What Emmanuel said:** It's not enough that `OrderModify` exists on both sides.
You need to prove that when a Telegram signal says "move SL to breakeven," the
exact same thing happens — same basket selection, same SL value, same DB update,
same reconciliation state.

**What we added:** A formal checklist of 16 behavioral scenarios that must pass
on both providers before any real account moves:

| Behavior | FxSocket | MTAPI shadow | MTAPI write |
|----------|----------|-------------|-------------|
| Single BUY signal | must pass | must pass | must pass |
| Single SELL signal | must pass | must pass | must pass |
| Multi-leg signal | must pass | must pass | must pass |
| Pending order | must pass | must pass | must pass |
| Modify SL | must pass | must pass | must pass |
| Modify TP | must pass | must pass | must pass |
| Break-even | must pass | must pass | must pass |
| Partial TP | must pass | must pass | must pass |
| Trailing stop | must pass | must pass | must pass |
| Close one trade | must pass | must pass | must pass |
| Close all | must pass | must pass | must pass |
| Broker manual SL override | must pass | must pass | must pass |
| Duplicate message blocked | must pass | must pass | must pass |
| OrderSend timeout → safe | must pass | must pass | must pass |
| Empty broker snapshot → defer close | must pass | must pass | must pass |
| Worker restart recovers | must pass | must pass | must pass |

**How we verify it:** Each row is a test case. All must pass before any real
account is moved.

### Gate 5 — Prove you can switch back while trades are still open

**What Emmanuel said:** The plan says rollback is just flipping a database column
from `mtapi` to `fxsocket`. But prove it with real open positions. Open a trade
through MTAPI, leave it open, flip back to FXSocket, and verify that FXSocket
discovers the existing position, can modify it, can close it, and doesn't open a
duplicate.

**What we added:** A 12-step rollback test:

1. Start account on FXSocket. Open a position via TScopier.
2. Switch to MTAPI. Verify MTAPI sees the same position.
3. Open another position via TScopier (now through MTAPI).
4. Verify: MTAPI sees it, TScopier DB sees it, MT5 sees it.
5. Leave BOTH positions OPEN.
6. Flip provider back to FXSocket.
7. Verify FXSocket discovers both broker tickets.
8. Send: move SL to breakeven on the MTAPI-created position.
9. Verify FXSocket modifies the existing position (not a new one).
10. Partial close it.
11. Close it fully.
12. Verify: no duplicate positions, no ghost DB trades, no reconciliation
    corruption.

**How we verify it:** All 12 steps pass. Rollback is safe with open trades.
