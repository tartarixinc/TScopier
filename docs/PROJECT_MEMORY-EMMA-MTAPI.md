# Project Memory - Emma - MTAPI

## 2026-09-16 - Phase 2 READ-ONLY MTAPI implementation

### Scope

Implemented the worker-side Phase 2 read path only. MTAPI trading remains
disabled: OrderSend, pending placement, OrderModify, OrderClose, partial close,
and MTAPI layering were not implemented.

### Reads implemented

- Connection/session status: CheckConnect, ConnectionStatus, legacy status
  adapters, and one-shot read recovery after INVALID_TOKEN.
- AccountSummary, including the MTAPI synced flag.
- OpenedOrders, ClosedOrders, OrderHistory, OrderHistoryPagination, and
  HistoryPositions.
- GetQuote, Symbols, and SymbolParams.
- Successful MTAPI empty-list responses remain authoritative. HTTP failures,
  MTAPI error payloads, and malformed list responses throw; they never normalize
  to an authoritative empty snapshot.
- synced=false is returned to callers and is rejected as authoritative live
  equity by copy-limit metrics.

### Session lifecycle

- Added ConnectEx plus host/port Connect, ConnectByToken, CheckConnect,
  disconnect, keepalive/health sweep, and token-first reconnect.
- Reads that receive INVALID_TOKEN recover the token once and retry once.
- Added encrypted credential fallback using the existing AES-256-GCM helper.
  Plaintext exists only transiently for ConnectEx and is never logged.
- Added trade-worker startup reconciliation through DisconnectOrphans: dry-run
  first, then apply. A shared bridge receives one combined known-token list;
  independently configured MT4/MT5 bridges receive platform-specific lists.
- Added service-role-only MTAPI session/credential columns and a client-write
  guard migration.

### Provider resolution

- Null/empty provider and fxsocket continue to resolve to the existing
  FxsocketProvider.
- mtapi resolves to MtapiProvider.
- Unknown providers and invalid session IDs fail closed.
- Session identity is provider-specific: MTAPI uses mtapi_session_id; FXSocket
  keeps fxsocket_account_id with the accepted legacy fallback.

### Files changed for Phase 2

- worker/src/mtapiProvider.ts
- worker/src/mtapiProvider.test.ts
- worker/src/mtapiSessionManager.ts
- worker/src/mtapiSessionManager.test.ts
- worker/src/providerResolver.ts
- worker/src/providerResolver.test.ts
- worker/src/brokerProvider.ts
- worker/src/fxsocketProvider.ts
- worker/src/fxsocketClient.ts
- worker/src/mtApiByAccount.ts
- worker/src/index.ts
- worker/src/copyLimitMetrics.ts
- worker/src/copyLimitMonitor.ts
- worker/src/applySignalOverride.ts
- worker/src/forceCloseSignalTrades.ts
- worker/src/tradeExecutor/TradeExecutor.ts
- worker/src/tradeExecutor/helpers.ts
- worker/src/tradeExecutor/types.ts
- supabase/migrations/20260916120000_mtapi_read_sessions.sql
- docs/PROJECT_MEMORY-EMMA-MTAPI.md
- docs/PROJECT_MEMORY-EMMA.md

### Decisions

- MTAPI write methods fail locally with MTAPI_READ_ONLY and make no HTTP
  request.
- Error messages never include request URLs, query strings, passwords, or proxy
  keys.
- Token recovery is CheckConnect -> ConnectByToken -> encrypted credential
  fallback only when the token is genuinely invalid.
- Session startup failure is non-fatal to the worker, preserving existing
  FXSocket operation.
- No edge-function or frontend MTAPI connection ownership was added; the worker
  remains the session owner.

### Tests

- Focused MTAPI provider/session/resolver tests: PASS, 19/19.
- Worker typecheck (npx tsc --noEmit): PASS.
- Worker build (npm run build): PASS.
- Relevant FXSocket/v2/provider regressions: PASS, 16/16.
- git diff --check: PASS.
- Broad unrelated test suites were not run.

### Real MTAPI acceptance

NOT_PERFORMED.

This implementation was not connected to a real hosted or self-hosted MTAPI
instance, and no real demo-account read comparison was performed in this work.

### Blockers

- Apply 20260916120000_mtapi_read_sessions.sql in the migration environment.
- Configure the MTAPI base URL(s), proxy key, and broker-credential encryption
  key on the trade worker.
- Provision a dedicated MTAPI demo broker row with a stored session token and
  encrypted password.
- Validate every read against the real bridge, including a true empty
  OpenedOrders, an unsynced AccountSummary, token expiry/recovery, bridge restart
  credential fallback, and the bridge's exact DisconnectOrphans multipart
  contract.

### James handoff

1. Review the Phase 2 migration and service-role credential exposure rules.
2. Apply the migration in the migration environment only.
3. Configure MTAPI_BASE_URL or platform-specific base URLs, MTAPI_PROXY_KEY,
   and BROKER_CREDENTIALS_ENCRYPTION_KEY.
4. Create one dedicated demo MTAPI account row; do not reuse an account that is
   simultaneously connected through FXSocket.
5. Run real acceptance for status, summary/synced, opened/zero orders, quote,
   symbols/spec, and all history reads.
6. Force token expiry and bridge restart, then verify token-first reconnect,
   encrypted fallback, persisted token update, and orphan reconciliation.
7. Do not enable MTAPI writes or layering. Phase 3 requires separate approval.

## 2026-09-29 - Phase 4A schema truth for MTAPI status

### Audit blocker

Current worker, edge-function, and frontend code read or write
`broker_accounts.mtapi_status`, but no checked-in migration created the column.
This made a clean production deployment fail as soon as those runtime paths
selected or updated the missing field.

### Schema decision

`mtapi_status` is the provider-specific MTAPI session lifecycle badge. It is
separate from the shared `connection_status` workflow state and from
`terminal_connected` / `trade_allowed` terminal-health facts.

The column is nullable `text`, has no default, and is constrained to:

- `connecting`
- `connected`
- `error`
- `disconnected`

`NULL` means the MTAPI-specific state is not applicable or has not yet been
observed. Frontend status resolution already falls back to
`connection_status` when an MTAPI row has a null `mtapi_status`.

### Migration added

- `supabase/migrations/20260929120000_add_broker_accounts_mtapi_status.sql`

The migration runs after the provider, MTAPI session/credential, and linked
account type migrations. It adds the column and CHECK constraint, documents
the contract, and grants authenticated clients SELECT access to the column.
The explicit grant is required because
`20260916120000_mtapi_read_sessions.sql` replaced table-level SELECT with
column-level grants.

### Compatibility and backfill decision

No rows are backfilled and no default is assigned. Existing FXSocket rows keep
all existing status fields unchanged and receive `mtapi_status = NULL`.
Existing MTAPI rows also start null when the column is introduced; current
code safely falls back to `connection_status`, and the worker or reconnect path
then records the first provider-specific status. This avoids inventing an
MTAPI state from a shared or legacy status field.

The existing `BrokerAccount.mtapi_status` TypeScript union already matches the
database contract, so no TypeScript database type change was required.

### Tests

- Disposable PostgreSQL 15 migration fixture: PASS. Verified `text`, nullable,
  no default, authenticated column SELECT, all four accepted states, invalid
  state rejection, unchanged FXSocket rows, and a second idempotent replay.
- Frontend `brokerReconnect.test.ts`: PASS, 13/13.
- Frontend `brokerLink.test.ts`: PASS, 20/20.
- Worker typecheck (`npx tsc --noEmit --pretty false`): PASS.
- Worker build (`npm run build`): PASS.
- Frontend typecheck (`npx tsc -b --pretty false`): PASS.
- Frontend production build (`npm run build`): PASS.
- Full clean Supabase migration replay: not available locally; the Supabase CLI
  is not installed and the full chain requires Supabase-specific roles and
  extensions. Migration ordering and the focused PostgreSQL replay were
  verified instead.
## 2026-09-29 - Phase 4B same-row MTAPI preparation

### One-time password requirement

An FXSocket session or token cannot be converted into an MTAPI session. Existing
users must provide their MT4/MT5 broker password once so MTAPI can authenticate
the canonical login, server, and platform already stored on their existing
`broker_accounts` row.

### Same-row preparation design

The authenticated `mtapi-broker` action `prepare_migration` accepts only
`broker_account_id` and `account_password`. The edge function loads the row
by both `broker_accounts.id` and authenticated `user_id`, requires the row''s
current provider to be `fxsocket`, and uses the row''s canonical login, server,
and MT4/MT5 platform. It does not run new-account plan limits, duplicate-account
checks, or an insert.

Preparation encrypts the credential first, calls MTAPI `ConnectEx`, requires
`CheckConnect` to return OK, and verifies `AccountSummary`. It then updates
the same row with the MTAPI session, encrypted credential,
`auto_reconnect_enabled = true`, `mtapi_status = ''connected''`, and
`password_updated_at`.

The response strips `mtapi_session_id` and `broker_password_encrypted`.
The frontend exposes a reusable `prepareExistingBrokerForMtapi` helper, but no
launch CTA or migration-modal product flow was added in this phase.

### Provider and open-trade safety

Preparation deliberately leaves `provider = ''fxsocket''`,
`fxsocket_account_id`, the broker row ID, and all other account/trade/config
relationships unchanged. Active-provider terminal health fields are also left
unchanged because FXSocket remains the writer. Worker provider-resolution
coverage proves that a prepared row containing both session identities still
selects the FXSocket session and provider.

Writer activation and its fencing remain Phase 4C work.

### Encryption decision

MTAPI credential persistence now fails closed. `encryptMtPasswordRequired`
rejects requests when no supported encryption key is configured or encryption
fails. The connect and reconnect paths no longer fall back to storing a raw
password. Application errors do not contain passwords, and the MTAPI client
does not log request URLs or query strings.

### Failure and re-preparation behavior

Failures before persistence leave the FXSocket provider, FXSocket account ID,
existing MTAPI credential/session, and broker row unchanged. A newly created
session is disconnected after verification or confirmed persistence failure.
If the DB update response is ambiguous, the row is re-read first: an observable
commit is accepted, a confirmed non-commit is cleaned up, and an unknown outcome
does not disconnect a token the row may reference.

Successful re-preparation updates the same row, then best-effort disconnects the
previous distinct MTAPI session. A token already stored on the row is never
disconnected by a failed verification attempt. No additional broker-account
slot or duplicate broker row is created.

### Tests

- Deno focused MTAPI preparation, credential crypto, and client tests: PASS.
  Coverage includes ownership, canonical MT4/MT5 credentials, wrong password,
  service outage/timeout, malformed connect response, CheckConnect and
  AccountSummary failure, fail-closed encryption, persistence failure and
  ambiguity, secret stripping, and re-preparation.
- Frontend preparation helper tests: PASS, 5/5.
- Worker provider resolver tests: PASS, 9/9, including prepared-row routing.
- Worker typecheck and build: PASS.
- Frontend typecheck and production build: PASS.
- Integrated edge-function Deno check was attempted but not completed because
  the edge-runtime npm auto-resolution timed out; focused imported modules were
  type-checked by their Deno tests.
- `git diff --check`: PASS.

### Real MTAPI acceptance

NOT_PERFORMED. No real MTAPI bridge/account was contacted in Phase 4B. Launch
UX, real ConnectEx/CheckConnect/AccountSummary acceptance, and writer
activation/fencing remain required before production cutover.

## 2026-09-29 - Phase 4C single-writer fencing and controlled activation

### Authoritative writer design

broker_accounts.provider remains the authoritative writer only while
provider_transition_state = 'stable'. A monotonic writer_epoch invalidates
work captured before any forward or rollback transition.
provider_transition_target is populated only while the account is fenced in
transition; no separate provider timestamp was needed.

Every broker mutation resolved through the worker provider seam now acquires a
short-lived broker_write_leases row immediately before the external call.
The database validates broker row ID, provider, provider-specific session ID,
stable state, and expected writer epoch under a row lock. The same guard covers
market/pending sends, modify/cancel/partial/full close, management, trailing,
auto-management, partial TP, basket follow-up/reconciliation, force close, and
copy-limit flattening. The active raw FxSocket v2 send, close, and reconciliation
exceptions are wrapped explicitly. Worker and edge reconnects use the same
lease so session replacement cannot race provider activation.

The MTAPI orphan allow-list now includes prepared MTAPI sessions on
FXSocket-active rows, preventing preparation tokens from being disconnected
before activation.

### Transition and fence semantics

The transition RPC atomically changes stable -> transition and increments
writer_epoch. That row lock serializes with lease acquisition: operations
that acquired a lease first are allowed to finish, while all later operations
fail closed. Existing leases may renew while draining, but no new lease can be
created. Activation waits for all prior-epoch leases to finish or expire before
the provider flip.

Stale work is rejected rather than silently rerouted. This covers stale
FXSocket jobs after MTAPI activation, stale MTAPI jobs after rollback, and a
full FXSocket -> MTAPI -> FXSocket cycle where the preserved session ID is the
same but the epoch has advanced.

### Internal activation sequence

The new provider-transition edge function has no frontend entry point and
accepts only the configured service-role bearer token. activate_mtapi
requires a stable FXSocket writer, encrypted credential, connected MTAPI
status, MTAPI session, successful CheckConnect, and authoritative
AccountSummary. It then begins the fence, drains writes, reloads the
authoritative transition row, repeats both MTAPI checks, and atomically flips
the same broker row to provider = 'mtapi' and stable.

The existing row ID, FXSocket ID, MTAPI session, trade/config foreign keys,
channel/risk settings, and performance baseline are not rewritten. FXSocket is
not remotely deleted or disconnected by activation.

Handled failures before the flip abort back to the prior stable provider while
retaining the incremented epoch. A lost finish response is resolved by
authoritative reread. If the outcome cannot be observed, the account remains
fail-closed in transition rather than guessing or enabling two writers.

### Rollback primitive

The internal rollback_fxsocket action uses the identical epoch, transition,
lease-drain, and atomic-finish sequence and requires a preserved FXSocket
account ID. It does not disconnect MTAPI. This is writer-authority rollback
only; open-position ticket/position compatibility is intentionally not claimed
until Phase 4E / Fix #5 acceptance.

### Known residual race

No client-side fence can prove what a remote broker did after an HTTP timeout
or connection loss. A broker/bridge can apply a request after the caller sees
an ambiguous timeout. Leases close the local distributed scheduling race, but
remote late application still requires provider idempotency, broker reads, and
reconciliation. Real bridge behavior under timeout/restart remains untested.

### Tests and real acceptance

Focused worker authority/provider/session tests passed 16/16 and cover stable
FXSocket/MTAPI authority, transition blocks, wrong sessions, stale
provider/epoch rejection, preparation routing, and provision/activation CAS.
Affected force-close tests
passed 12/12; order-leg and reply-scoped management tests passed 6/6. Focused
Deno preparation/transition/lease/crypto/migration tests passed 26/26 and cover
same-row activation, pre-flip failure recovery, concurrent activation,
rollback, preserved sessions, ambiguous finish observation, secret-free
output/logs, and migration invariants. The new lease helper, transition
orchestrator, and internal transition function pass Deno check. Worker
typecheck/build, frontend typecheck/build, and git diff --check pass.

The repository's two existing broker Edge entry files do not currently pass a
whole-file Deno check under the installed Supabase/Deno type resolver: it
reports existing untyped-client generic/never inference errors across those
files. The new imported fencing modules check cleanly. No live database
migration replay was performed in Phase 4C.

REAL_ACCEPTANCE: NOT_PERFORMED. No real MTAPI or FXSocket account was switched
in Phase 4C, and no public migration control was added.


## 2026-09-29 - Phase 4D removal of hidden FXSocket runtime dependencies

### Provider-neutral runtime paths

Production trading and management paths no longer use global FXSocket
configuration as an availability gate. Trade dispatch and entry preparation,
management commands, message-revision closes, basket merge/close/SL-TP
reconciliation, Edit Signal Override, channel stops, force close, symbol-cache
maintenance, news pre-close, copy-limit flattening, pending cleanup, and the
background monitors now resolve the active provider through the broker row.

Open-trade reconciliation, trailing stop, automatic breakeven/management, CWE,
and news management load the current broker row by broker_accounts.id and
construct the provider client from the current provider, provider-specific
session, writer epoch, and transition state. The Phase 4C lease remains the
last authority check immediately before orderSend, orderModify, or orderClose.
A transition therefore blocks monitor mutations, and a stale provider/session
cannot gain authority from a durable work row.

The force-close Edge function now validates the current provider-specific
session and stable transition state. It no longer requires
fxsocket_account_id for an MTAPI broker. Ownership and channel-link checks are
unchanged.

### Durable session ID policy

partial_tp_legs, signal_entry_pending_orders, range_pending_legs, and
signal_range_entry_waits retain their captured metaapi_account_id values as
historical/debug metadata. Execution does not treat that value as authority.
resolveDurableBrokerArtifacts loads broker_accounts by broker_account_id,
selects the current provider/session/epoch, and rewrites only an in-memory copy
of each artifact before broker reads or writes.

This policy covers scheduled partial TP, strict-entry pending cancellation and
fill reconciliation, range broker-pending reconciliation/cancellation, virtual
range firing, signal-range wake quotes, copy-limit pending cancellation, and
basket-empty pending cleanup. No historical database rows or trade tickets are
rewritten. FXSocket artifacts can execute through MTAPI after activation, and
MTAPI artifacts resolve back to FXSocket after a controlled rollback, subject
to Phase 4E ticket-compatibility acceptance.

Open-trade reconciliation keeps its existing conservative empty-snapshot
behavior: an empty OpenedOrders response while local trades are tracked is
inconclusive and does not mass-close local rows.

### Intentional FXSocket-only boundaries

FXSocket WebSocket streaming and the broker stream proxy remain FXSocket-only.
MTAPI accounts are excluded from useFxsocketStream by provider, even though
fxsocket_account_id is preserved for rollback, and continue through the
existing provider-aware Edge polling/database snapshot paths. Assistant setup
and broker-list connected counts also use the active provider session. Rich MTAPI
WebSocket parity is not implemented and requires real dashboard acceptance.

The raw FxSocket v2 reconciliation engine, FxSocket broker Edge API, explicit
FxSocket diagnostics, and FxSocket-backed backtesting remain provider-specific.
They no longer gate the provider-neutral worker paths.

Native broker-pending layering remains explicitly FXSocket-only because exact
MTAPI placement, client-reference adoption, ambiguous-send recovery, and
cancellation parity have not been proven. Both worker and Edge capability
checks reject provider=mtapi even when fxsocket_account_id is preserved for
rollback. Existing pending artifacts are still reconciled/cancelled through
the current provider seam; new MTAPI native layering is not advertised.

### MTAPI-only environment and tests

A configuration-level regression removes FXSOCKET_API_KEY and FXSOCKET_URL,
marks the FXSocket provider unavailable, and proves that an MTAPI broker row
resolves its current session and provider client. A migration-window regression
also proves that an FXSocket-active row containing a prepared MTAPI session
continues to resolve FXSocket.

Focused results:

- Worker TypeScript check: PASS.
- Worker production build: PASS.
- Provider/current-session/native-layering tests: PASS, 20/20.
- Provider-neutral runtime architecture tests: PASS, 5/5.
- Reconciliation, trailing stop, automatic management, copy-limit, and runtime
  tests: PASS, 49/49, including empty OpenedOrders protection.
- Broader affected provider/fence/force-close/partial/CWE/virtual-pending tests:
  93 passed; the initial run had one compile-only fixture failure after
  BrokerApiMetadata gained required identity fields. The fixture was corrected
  and its provider suite then passed 19/19.
- Modified force-close and layering Edge functions: Deno check PASS.
- Frontend broker-link/stream eligibility tests: PASS, 20/20.
- Frontend typecheck and production build: PASS.
- The three force-close/layering Edge functions pass Deno check. The existing
  assistant-chat whole-file check still reports five pre-existing unrelated
  typing errors in assistantConfigTools/tool-argument handling; the changed
  provider-session query itself emitted no new diagnostic.

REAL_ACCEPTANCE: NOT_PERFORMED. No real MT4/MT5 bridge, provider cutover,
pending fill, partial close, restart, dashboard, or ticket-compatibility test
was performed in Phase 4D.
