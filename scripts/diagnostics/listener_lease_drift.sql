-- Users with an active Telegram session but no fresh listener lease.
-- Run in Supabase SQL editor or psql when trades skip with telegram_listener_not_live.

SELECT
  s.user_id,
  u.email,
  l.worker_id,
  l.role,
  l.expires_at,
  l.updated_at AS lease_updated_at,
  CASE
    WHEN l.expires_at IS NULL THEN 'no_lease_row'
    WHEN l.expires_at <= now() THEN 'lease_expired'
    WHEN l.role NOT IN ('listener', 'all') THEN 'wrong_role'
    ELSE 'ok'
  END AS lease_state
FROM telegram_sessions s
LEFT JOIN auth.users u ON u.id = s.user_id
LEFT JOIN worker_session_leases l ON l.user_id = s.user_id
WHERE s.is_active = true
  AND (
    l.expires_at IS NULL
    OR l.expires_at <= now()
    OR l.role NOT IN ('listener', 'all')
  )
ORDER BY l.expires_at NULLS FIRST;

-- Listener pod health: compare in-memory listeners vs DB leases (run against worker /health JSON).
-- Alert when lease_mismatch=true or lease_gap > 0.
