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
