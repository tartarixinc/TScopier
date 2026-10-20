# Social provider performance methodology

## Scope and identity

The canonical source-account identifier is `broker_accounts.id`. A provider
publishes an account through `social_copy_sources.broker_account_id`, and only
`trades` rows with the same `broker_account_id` enter that source's public
history or metrics.

The dataset is explicitly **TSCopier-managed history**, not a complete broker
ledger. Manual broker trades and activity not persisted in `public.trades` are
not represented. A recent `broker_accounts.last_synced_at` proves a successful
source-account state synchronization; it does not prove that an entire broker
ledger was imported.

Historical duplicate `(broker_account_id, metaapi_order_id)` rows are collapsed
to one position. A trade whose broker ticket matches a social-copy destination
mapping is excluded, preventing internally copied activity from being presented
as original provider performance or counted twice.

## Integrity and freshness

Performance state is evaluated at request time:

- `pending`: no successful source-account synchronization is recorded.
- `failed`: the source connection is in the error state.
- `unavailable`: the source account is missing, inactive, disconnected, or its
  provider/platform is unsupported.
- `stale`: the last successful source-account synchronization is older than 15
  minutes.
- `incomplete`: a closed TSCopier trade lacks a broker ticket or realized P/L.
- `no_history`: the source is healthy but has no persisted open or closed trade.
- `available`: the source is healthy and fresh and every closed row needed by
  the calculation is complete.

`calculated_at` is the database statement timestamp for the current calculation.
It is not stored or presented as a synchronization timestamp.

## Metrics

- **Realized P/L:** sum of `trades.profit` for complete, deduplicated closed
  positions. The ingestion path prefers broker `netProfit` when provided and
  otherwise stores the broker deal profit. Because commission, swap, and fees
  are not independently available for every provider, the number must be
  described as broker-reported realized P/L, not universally net of every fee.
- **Closed trade count:** count of complete, deduplicated closed positions.
- **Win rate:** profitable closed positions divided by all closed positions.
  Break-even positions remain in the denominator.
- **Profit factor:** gross positive P/L divided by the absolute gross negative
  P/L. It is unavailable when there are no losing positions; infinity is not
  emitted.
- **Open positions:** shown separately and excluded from realized metrics.
- **Return percentage:** unavailable. Current balance and realized P/L do not
  provide a defensible return calculation without deposits, withdrawals,
  transfers, starting capital, and time-weighting policy.
- **Maximum drawdown and equity curve:** unavailable. They require periodic,
  timestamped equity observations and cash-flow adjustments, which the current
  schema does not contain.

One source has one account currency. The RPC returns that currency where known;
metrics are never aggregated across source accounts or currencies.

## Copy eligibility policy

The server permits a new social-copy subscription only when all of these are
true:

1. the source is published, belongs to the provider, and uses a supported
   FxSocket/MTAPI MT4 or MT5 connection;
2. the source and destination are active, connected demo accounts;
3. source synchronization succeeded within the last 15 minutes;
4. scoped history contains no incomplete closed trades;
5. it contains at least 10 complete closed positions spanning at least 7 days;
6. normal social-profile and private-profile follow authorization still passes.

The worker authorization RPC rechecks the same eligibility on every reconcile.
Live copy execution remains disabled by the existing worker feature flags.
