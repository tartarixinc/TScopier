/**
 * Product latency targets: Telegram signal → first broker OrderSend (worker-side).
 * Excludes gramjs network delivery and live FXSocket/MT4/MT5 RTT.
 */
export const TELEGRAM_TO_TRADE_TARGET_MS = 5
export const TELEGRAM_TO_TRADE_MAX_MS = 80

/** Sync-only stages (parse + eligibility + dispatch job build). */
export const TELEGRAM_SYNC_STAGE_TARGET_MS = 5

/** Worker prep after dispatch accept until caches resolved (warm path). */
export const BROKER_CACHE_WARM_TARGET_MS = 5

/** Leg planning between cache resolve and mock OrderSend. */
export const SEND_PLAN_TARGET_MS = 5

/** Default multi-user load shape for perf tests. */
export const LOAD_TEST_USER_COUNT = 10
export const LOAD_TEST_TRADES_PER_USER = 5
export const LOAD_TEST_CONCURRENCY = 8

/** Heavier burst: many users × multiple trades. */
export const LOAD_BURST_USER_COUNT = 25
export const LOAD_BURST_TRADES_PER_USER = 4
export const LOAD_BURST_CONCURRENCY = 8
