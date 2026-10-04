/**
 * Execution-engine cutover flag (Phase 6).
 *
 * v2 (this engine/ rebuild) runs OFF by default and is enabled per broker/user so it
 * can be parallel-run and validated against v1 before v1 is deleted. Resolution order:
 *   1. EXECUTION_ENGINE=v2            -> v2 for everyone (global switch)
 *   2. EXECUTION_ENGINE_V2_BROKERS    -> comma list of broker_account ids on v2
 *   3. EXECUTION_ENGINE_V2_USERS      -> comma list of user ids on v2
 *   otherwise v1.
 */
export type ExecutionEngineVersion = 'v1' | 'v2'

function parseIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

/** True when any v2 routing is configured at all - used to avoid starting the v2
 * reconcile loop (and its per-tick trades scan) when nobody is on v2. */
export function v2EngineConfigured(env: ExecutionModeEnv = process.env): boolean {
  if ((env.EXECUTION_ENGINE ?? '').trim().toLowerCase() === 'v2') return true
  if (parseIds(env.EXECUTION_ENGINE_V2_BROKERS).size > 0) return true
  if (parseIds(env.EXECUTION_ENGINE_V2_USERS).size > 0) return true
  return false
}

export type ExecutionModeEnv = {
  EXECUTION_ENGINE?: string
  EXECUTION_ENGINE_V2_BROKERS?: string
  EXECUTION_ENGINE_V2_USERS?: string
}

export function resolveExecutionEngine(
  args: { brokerAccountId?: string | null; userId?: string | null; provider?: string | null },
  env: ExecutionModeEnv = process.env,
): ExecutionEngineVersion {
  // MTAPI accounts never use FxClient (FxSocket). Bypass EXECUTION_ENGINE entirely —
  // see docs/mtapi-migration-plan.md (provider resolver returns MtapiProvider directly).
  if (String(args.provider ?? '').trim() === 'mtapi') return 'v1'
  if ((env.EXECUTION_ENGINE ?? '').trim().toLowerCase() === 'v2') return 'v2'
  const brokers = parseIds(env.EXECUTION_ENGINE_V2_BROKERS)
  if (args.brokerAccountId && brokers.has(args.brokerAccountId)) return 'v2'
  const users = parseIds(env.EXECUTION_ENGINE_V2_USERS)
  if (args.userId && users.has(args.userId)) return 'v2'
  return 'v1'
}

export function isV2(
  args: { brokerAccountId?: string | null; userId?: string | null; provider?: string | null },
  env?: ExecutionModeEnv,
): boolean {
  return resolveExecutionEngine(args, env) === 'v2'
}

/**
 * Partition a signal's matching brokers into v1 vs v2 lanes so the two engines can
 * run side by side during cutover. With the flag off every broker lands in `v1` and
 * behavior is byte-for-byte unchanged. MTAPI brokers always stay in `v1`.
 */
export function splitBrokersByEngine<T extends { id: string; user_id?: string | null; provider?: string | null }>(
  brokers: T[],
  env?: ExecutionModeEnv,
): { v1: T[]; v2: T[] } {
  const v1: T[] = []
  const v2: T[] = []
  for (const b of brokers) {
    if (isV2({ brokerAccountId: b.id, userId: b.user_id ?? null, provider: b.provider }, env)) v2.push(b)
    else v1.push(b)
  }
  return { v1, v2 }
}
