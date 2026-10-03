# MTAPI migration project memory

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
