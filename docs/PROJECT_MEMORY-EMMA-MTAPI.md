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
