# MTAPI Migration — Progress Log (Sanitized)

**Date:** 2026-09-16
**Status:** Phase 1 repaired and verified; Phase 2 not started

> **Repair note (2026-09-16):** The original Phase 1 notes below are superseded
> where they describe fallback for unknown providers, MTAPI layering support,
> an MTAPI close-audit source, or a missing database CHECK. Null/absent provider
> values use FXSocket; `mtapi` and unknown values fail closed. The migration now
> checks `provider in ('fxsocket', 'mtapi')`, and MTAPI layering remains unsupported.

> **Note:** This is the sanitized version of `docs/mtapi-progress.md` (gitignored).
> Credentials, tokens, and account details have been redacted.

## What We've Done

### 1. Migration Plan Review & Fixes

**Reviewed** `docs/mtapi-migration-plan.md` with 3 parallel subagents (code-tester, code-review, general).

**Applied 16 edits** fixing gaps:
- §3.1: Added vestigial session lifecycle functions as 4th problem + items 5-6
- §5.2: Added Worker WebSocket stream layer subsection (`fxsocketWsClient.ts`, `fxsocketStreamManager.ts`, `brokerStreamProxy.ts`)
- §5.2: Clarified frontend talks to worker proxy (provider-agnostic)
- §6: Added Phase 2.5 (frontend provider awareness), renumbered phases
- §6 Phase 0: Added rate-limit measurement checklist + broker concurrent-login test
- §8: Split `force-close-trades` from `retry-signal`/`retry-activity`, added `layeringBrokerCapability.ts`, `mtApiByAccount.ts`, worker WS stream layer files
- §10: Added broker-level concurrent login caveat
- §11: Added broker login conflict risk + demo credentials dead note
- §13: Added 4 missing file references
- Updated pricing info ($500-$1,500/mo cloud, $1,000/mo on-prem)
- Noted MTAPI demo credentials are dead as Phase 0 blocker

### 2. Phase 0 Conformance Testing

**Environment:** Hosted MTAPI (`mt5.mtapi.io`) with Exness demo account

**Confirmed endpoints:**

| Endpoint | Status | Notes |
|----------|--------|-------|
| `ConnectEx` | ✅ Works | Uses server name, returns plain text token |
| `Connect` | ✅ Works | Fallback, uses host:port |
| `ConnectByToken` | ✅ Works | Reconnects without password, even after Disconnect |
| `CheckConnect` | ✅ Works | Returns `OK` (plain text) |
| `Disconnect` | ✅ Works | Returns `OK` (plain text) |
| `ConnectionStatus` | ✅ Works | Returns JSON with `isConnected`, `connectTimeUTC` |
| `AccountSummary` | ✅ Works | Returns all fields including `synced: true` |
| `GetQuote` | ✅ Works | Returns bid/ask/time |
| `Symbols` | ✅ Works | Returns all available symbols |
| `SymbolParams` | ✅ Works | Returns symbol details + group info |
| `OpenedOrders` | ✅ Works | Returns `[]` when empty |
| `OrderHistory` | ✅ Works | Returns trades + balance operations |
| `ClosedOrders` | ✅ Works | Returns `[]` when empty |
| `OrderSend` | ⚠️ MARKET_CLOSED | Cannot test on Saturday |
| `OrderSendSafe` | ⚠️ MARKET_CLOSED | Cannot test on Saturday |
| `OrderModifySafe` | ⚠️ INVALID_TICKET | Need real position to test |
| `Search` | ✅ Works | Finds broker servers by company name |
| `ConnectionStatusAll` | ❌ Requires admin key | Not available on trial |

**Key findings:**

1. **Token-based reconnect works.** `ConnectByToken` reconnects without password, even after explicit `Disconnect`. This is the primary reconnect path.

2. **Token is deterministic.** Same account always returns the same UUID token.

3. **Response formats vary.** Connection endpoints return plain text. Everything else returns JSON.

4. **Exness uses `m` suffix.** Symbol names are `EURUSDm`, `GBPUSDm`, etc. Must use the broker's actual symbol names.

5. **`AccountSummary.synced` confirmed.** Boolean field present in response.

6. **`AccountSummary.method` = "Hedging".** Multiple positions per symbol allowed.

7. **Operation enum accepts both string and integer.** `"Buy"` and `0` both work.

8. **Market closed on weekends.** Cannot test order lifecycle on Saturday/Sunday.

9. **`Search` endpoint works.** Finds broker servers by company name.

10. **`ConnectionStatusAll` requires admin key.** Not available on trial.

11. **Concurrent requests are safe.** Tested 15+ combinations with 100% success rate. Initial `CONNECT_ERROR` was transient.

12. **Handle `INVALID_TOKEN` during disconnect.** Catch, reconnect, and retry.

13. **WebSocket endpoints: `OnQuote` and `OnOrderUpdate` work.** Other endpoints return 404. Returns last known quote during market closure.

14. **Operation enum: 0-7 valid, 8 invalid, 100-101 timeout.** Bridge accepts any integer and passes to MT5 terminal.

15. **Order lifecycle works.** OrderSendSafe → OpenedOrders → OrderModifySafe → OrderCloseSafe → ClosedOrders all confirmed.

16. **OrderModifySafe with only SL succeeds.** Contrary to plan assumption, SL+TP are NOT required together. Bridge allows modifying one field at a time.

17. **Pending orders work.** BuyLimit and SellStop can be placed and cancelled. INVALID_PRICE when price too far from market.

18. **Token expires.** After ~5 minutes of inactivity, token becomes INVALID_TOKEN. Must reconnect.

19. **MaxSessions = 1 per account.** Token is deterministic, cannot create multiple concurrent sessions.

20. **Bridge restart session survival confirmed.** Orders and positions survive Disconnect + ConnectByToken reconnect (tested 5s and 10s intervals).

**Error codes observed:**

| Code | Meaning | HTTP |
|------|---------|------|
| `INVALID_ACCOUNT` | Wrong login/password/server | 201 |
| `INVALID_TOKEN` | Session not found (after disconnect) | 201 |
| `MARKET_CLOSED` | Trading when market is closed (weekend) | 201 |
| `INVALID_TICKET` | Order/position ticket not found | 201 |
| `INVALID_SYMBOL` | Symbol name wrong (e.g. EURUSD vs EURUSDm) | 201 |

### 3. Conformance Document

Written to `docs/mtapi-conformance.md` with full request/response examples for all tested endpoints.

## Blocked (market closed)

- `OrderSend` / `OrderSendSafe` — MARKET_CLOSED (Saturday)
- `OrderModifySafe` SL+TP validation — need real open position
- `OrderCloseSafe` — need real open position
- WebSocket endpoints — need live market

## Next Steps

1. **When market opens (Monday):** Place test order, verify full lifecycle
2. **Complete conformance doc** with order lifecycle results
3. **Sync migration branch** (currently stale, ~86-96 commits behind)
4. **Begin Phase 1** implementation after conformance is complete

## Files Modified

- `docs/mtapi-migration-plan.md` — 16 edits fixing gaps
- `docs/mtapi-conformance.md` — new file, Phase 0 test results

---

## Phase 1 — Complete (2026-09-14)

### What We Built

**BrokerProvider interface** (`worker/src/brokerProvider.ts`):
- Unified interface for broker operations (session lifecycle, orders, data reads, health)
- `BrokerProviderName` type: `'fxsocket' | 'mtapi'`
- `MtPlatform` type defined here to decouple from FxSocket

**FxsocketProvider** (`worker/src/fxsocketProvider.ts`):
- Wraps existing `FxsocketBrokerClient` behind the `BrokerProvider` interface
- All methods delegate to the existing client (no behavior change)

**Provider resolver** (`worker/src/providerResolver.ts`):
- `apiForBrokerAccount(provider, sessionId)` — dispatches to the right provider
- `inferProvider(row)` — infers provider from broker_accounts columns
- Falls back to fxsocket for unknown providers (forward compatibility)

**Database migration** (`supabase/migrations/20260914120000_add_broker_accounts_provider.sql`):
- Adds `provider` column (text, default `'fxsocket'`)
- Partial index on `provider = 'mtapi'` for fast lookup

**Updated files:**
- `worker/src/orderCloseAudit.ts` — source type now includes `'mtapi'`
- `worker/src/layeringBrokerCapability.ts` — provider type now includes `'mtapi'`; gate check allows 'mtapi'

**Tests** (`worker/src/providerResolver.test.ts`):
- 12 tests covering apiForBrokerAccount and inferProvider
- All pass (20/20 total across changed files)

### Verification

- **Typecheck:** PASS (tsc --noEmit clean)
- **Lint:** PASS (all changed files)
- **Tests:** PASS (20/20 across providerResolver, layeringBrokerCapability, orderCloseAudit)
- **Code-tester subagent:** PASS
- **Code-review subagent:** PASS_WITH_NOTES (all MEDIUM/LOW findings addressed)

### Hosting Decision

**Self-hosted Docker on Contabo** (Cloud VPS 4, 4 vCPU, 8 GB RAM, ~$6.60/mo).
Worker stays on Railway. Total hosting cost: ~$7/mo (Contabo) + existing Railway cost.

### Migration Plan Updates

- §2.3: Updated deployment model with Contabo decision
- §6 Phase 0: Added Contabo hosting decision with cost comparison
- §13: Added new Phase 1 files to references
- §13: Added `20260914120000_add_broker_accounts_provider.sql` to migrations list

## Pricing Research

| Tier | Price | Notes |
|------|-------|-------|
| Cloud (500 accounts) | $1,500/mo | Managed hosting |
| On-Premise | $1,000/mo | Self-hosted, needs license |
| Railway hosting | ~$85-100/mo | Compute only, needs license |
| **Contabo hosting** | **~$7/mo** | **Self-hosted Docker, 4 vCPU, 8 GB RAM** |

**Decision:** Contabo for MTAPI bridge. Worker stays on Railway.

## Next Steps (Phase 2)

1. **Implement MtapiProvider** for reads (shadow mode)
2. **Encrypted credential storage** (needed for bridge-restart recovery)
3. **Startup session reconciliation** via DisconnectOrphans
4. **Compare MTAPI vs FXSocket reads** on staging account
