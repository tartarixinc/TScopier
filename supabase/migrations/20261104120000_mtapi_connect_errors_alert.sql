-- MTAPI broker-login failures (bridge-wide).
--
-- A single account refused at `ConnectEx` is usually that account's problem
-- (wrong server, disabled account). Several at once is a bridge-wide fault:
-- an expired MTAPI licence/product, a dead terminal manager, or a broken
-- bridge. That was the 2026-11-04 incident: the MTAPI licence expired, every
-- *new* broker login was refused with `CONNECT_ERROR`, but existing sessions
-- kept running and `/health` still answered "Healthy", so nothing alerted and
-- customers reported it hours later.
--
-- Why not reuse mtapi_accounts_error: that rule fires on a percentage of all
-- MTAPI accounts. With ~230 accounts, a handful of login failures is 2-3% and
-- stays under the threshold exactly when the bridge is refusing new logins.
-- This rule counts the distinct parked accounts by their stored error instead,
-- so a small cluster is enough.
--
-- The evaluator counts active accounts showing a `CONNECT_ERROR` (or the
-- worker's plain-English "broker connection temporarily unavailable") in
-- either `pending` OR `error`. The worker treats `CONNECT_ERROR` as retryable,
-- so rows it owns stay `pending` and clear by themselves once the bridge
-- accepts logins again — the alert then resolves. Rows parked in `error` by an
-- older build do not retry; the alert's NEXT_ACTION carries the one-off reset
-- SQL, after which the normal provision sweep reconnects them.

INSERT INTO alert_rules (code, name, description, severity, threshold, window_minutes, cooldown_seconds)
VALUES (
  'mtapi_connect_errors',
  'MTAPI broker-login failures',
  'Several MTAPI accounts are currently refused at broker login (CONNECT_ERROR). This is the signature of a bridge-wide fault such as an expired MTAPI licence or a failed terminal, not isolated user credentials. New accounts cannot connect until it is fixed.',
  'critical',
  '{"min_accounts": 3}'::jsonb,
  15,
  1800
)
ON CONFLICT (code) DO NOTHING;
