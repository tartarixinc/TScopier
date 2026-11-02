# MTAPI migration project memory

## 2026-10-06 ? Phase 4F acceptance continuation

- Current `origin/staging` contains Phase 4F (`20bbac31`) plus newer MTAPI pacing/reconciliation and automatic `partial_tp_legs` hardening; those newer changes were preserved.
- Provider authority remains exclusively `broker_accounts.provider`. For `provider=mtapi`, only `mtapi_session_id` and the MTAPI source are used; prepared FXSocket IDs, FXSocket Symbols/PriceHistory/QuoteTicks, and `FXSOCKET_API_KEY` are not consulted. There is no cross-provider fallback in resolution, runner, resimulation, replay, or market-data loading.
- Provider/backtest regression suites pass and the `backtest-run` bundle passes full `deno check` after scoped EdgeRuntime/Supabase inference and portfolio accumulator compatibility fixes.
- Live staging acceptance is not complete: this workspace lacks a Supabase access token/user JWT/service key and all MTAPI credentials/timezone secrets. Deployment metadata, the authoritative broker row, the actual sanitized post-resolution error, MT5 execution, and MT4 bridge availability could not be queried truthfully.
- `MTAPI_HISTORY_TIMEZONE_UNVERIFIED` remains an intentional fail-closed gate. No UTC/server mode, timezone unit/sign, or `DST=none` policy was guessed; an authenticated read-only clock/history probe is still mandatory.
- Current `origin/main` contains Phase 4E and provider-neutral prerequisites but not Phase 4F. The raw `20bbac31` patch conflicts with current-main drift in `marketData.ts`, `resolveBacktestBroker.ts`, and `runner.ts`; selectively port and review the final Phase 4F file set instead of merging all staging changes.
- Git promotion is not an Edge deployment. Staging still requires `supabase functions deploy backtest-run` from its already-linked checkout after operator acceptance; production deployment commands are appropriate only after the reviewed code reaches main.
- Remaining MT5 acceptance: authoritative broker-row proof, `/Symbols`, BTCUSD?BTCUSDm, `/PriceHistory`, verified clock policy, short run saved, resimulation, replay, and zero FXSocket calls.
- Remaining MT4 acceptance: deployed bridge proof, `/Symbols`, `/QuoteHistory`, one short run, and zero FXSocket calls. MT4 unavailability does not invalidate truthful MT5 acceptance.

## 2026-10-01 — Phase 4E minimum pre-cutover identity safety

- Canonical runtime identity remains backward compatible with `OrderResult.ticket` while preserving optional `orderTicket`, `dealTicket`, and `positionTicket` from MTAPI responses.
- MT4 market and pending operations continue to use the broker order/position ticket returned by the MT4 contract.
- MT5 market opens use `positionTicket`; MT5 pending orders use `orderTicket` until an explicit OpenedOrders relationship proves and persists the resulting position ticket.
- `trades.metaapi_order_id` is unchanged at schema level. For an open trade it stores the current canonical live position ticket; replacement is persisted with a stale-ticket/status CAS.
- `livePositionIdentity.ts` is the single resolver for live open positions. It prefers explicit order/deal/position relationships, can use attributes only when the result is unique, and fails closed on ambiguity.
- Partial and full live-position management paths resolve the effective ticket before modify/close. `managementExecutor` partial-profit now sends `effectiveTicket`.
- `closeWithVerification` requires pre-close identity resolution and post-close broker readback. Readback failure, skipped verification, malformed/incomplete data, or ambiguity never confirms closure.
- Open-trade reconciliation retains empty-snapshot protection and now requires two consistent complete non-empty snapshots before closing an unmatched DB trade.
- MTAPI OpenedOrders rejects bridge responses explicitly marked partial/truncated/incomplete.
- MT5 activation is hedging-only. `AccountSummary.method` must authoritatively indicate hedging; netting is rejected with `MT5_NETTING_UNSUPPORTED`, and missing/unknown mode with `MT5_ACCOUNT_MODE_UNAVAILABLE`. MT4 activation is unaffected.
- James's Safe transport and bridge behavior remain unchanged: MT4/MT5 `OrderSendSafe`, `OrderModifySafe`, `OrderCloseSafe`, partial-close `lots`, MT4 `/Quote`, MT5 `/GetQuote`, MT4 history fallback, and paginated `OrderHistory`.

### Real broker acceptance still required

- Confirm actual MT4 market-position and pending-order ticket shapes on the production bridge.
- Confirm MT5 market-open and pending-fill responses expose the expected order/deal/position relationships.
- Confirm `OpenedOrders` completeness flags and explicit identity fields for both bridges.
- Exercise modify, partial close, full close, pending-to-filled adoption, TP/SL/manual closure reconciliation, and rollback using real hedging accounts.
- Verify the production MT5 `AccountSummary.method` value is present and classified as `Hedging` before activation.
- MT5 netting remains intentionally unsupported for this cutover.

## 2026-10-02 — Phase 4F provider-authoritative backtest market data

- Backtest market data now resolves from `broker_accounts.provider`; a prepared MTAPI session is never selected while the authoritative provider remains `fxsocket`.
- Stable MTAPI accounts require `mtapi_session_id` and `platform`, but do not require `fxsocket_account_id`, FXSocket connection state, or `FXSOCKET_API_KEY`.
- Provider transitions and unknown providers fail closed. Current schema requires `provider_transition_state='stable'`.
- `HistoricalMarketDataSource` is the provider-neutral contract shared by initial simulation, resimulation, and trade replay. It exposes broker symbols, normalized historical OHLC, and optional historical ticks.
- Normalized OHLC remains conservative for the unchanged simulator: `bid=low`, `ask=high`, `mid=close`.
- MT5 history uses read-only `GET /PriceHistory` with exact broker symbol, ISO `from`/`to`, integer-minute `timeFrame`, and bounded sequential windows of at most 4,000 requested bars.
- MT4 history uses read-only `GET /QuoteHistory` with string timeframe, `from`, and bounded `count`; long ranges are read backwards, then merged, deduplicated, sorted, and cropped.
- MT5 normalization accepts `time/openPrice/highPrice/lowPrice/closePrice` plus optional spread. MT4 normalization accepts documented/common casing variants only when variants agree; wholly unnormalizable non-empty MT4 responses fail rather than synthesize values.
- MTAPI `tick_quotes` deliberately records an unavailable/unverified notice and uses OHLC bars. No asynchronous MT5 TickHistory WebSocket was added.
- FXSocket `PriceHistory`, `QuoteTicks`, and `ServerTimezone` remain only inside the temporary `provider=fxsocket` adapter.
- `/ServerTimezone` and `/AccountDetails` are available to the MTAPI clock resolver, but the returned integer is never interpreted without an explicit verified policy.

### MTAPI history clock acceptance gate

Real MTAPI history is fail-closed until deployment acceptance sets:

- `MTAPI_HISTORY_TIMEZONE_VERIFIED=true`
- `MTAPI_HISTORY_TIMESTAMP_MODE=utc` when bar timestamps are verified UTC; or `server` when they are verified broker-local.
- For `server` mode only: `MTAPI_SERVER_TIMEZONE_UNIT_MT4=minutes` and `MTAPI_SERVER_TIMEZONE_UNIT_MT5=hours` (measured 2026-10-31: the MT5 bridge answers ServerTimezone in hours, the MT4 bridge in minutes; the global `MTAPI_SERVER_TIMEZONE_UNIT` remains as fallback), `MTAPI_SERVER_TIMEZONE_SIGN=server_minus_utc|utc_minus_server`, and `MTAPI_SERVER_TIMEZONE_DST=none|observed`. `none` claims every server keeps a fixed offset year-round; `observed` is the honest value for populations that include DST-seasonal servers (live offset applied; bars older than a server's last switch skew by at most one hour). An unknown DST value remains fail-closed.

**Acceptance completed 2026-10-31/11-02** (see `docs/scratchpad-backtest-mtapi-timezone-2026-10-31.md` and the `mtapi-clock-probe` staging diagnostic): every connected server on staging and prod was measured against independent market clocks across the 2025 and 2026 EU/US DST switches — Exness-type servers are UTC and never shift; ICMarkets/PUprime/Tickmill-type servers are server-local on the US DST calendar; one staging server is server-local on the EU DST calendar. Staging and prod secrets are set; the probe's `history` action verifies the real code path (last-bar skew ≈ 0). When a new broker server family appears, re-run `mtapi-clock-probe` before trusting backtest history on it. No session identifiers or credentials may be logged.

### Infrastructure and remaining migration scope

- MT5 code path is ready for live acceptance after the clock policy is verified and configured.
- MT4 code path and defensive fixture coverage are implemented, but deployment of the actual MT4 bridge/API remains a separate infrastructure verification.
- Final FXSocket removal is not part of Phase 4F. Its client, secret, and historical adapter remain required only for accounts whose authoritative provider is still `fxsocket`.
- Live acceptance should cover MT5 `Symbols` + `PriceHistory`, MT4 `Symbols` + `QuoteHistory`, a long chunked range, suffix/alias resolution, and `tick_quotes` OHLC fallback.
