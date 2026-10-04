export type BrokerWriterRow = {
  id: string
  provider?: string | null
  mtapi_session_id?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  writer_epoch?: number | null
  provider_transition_state?: string | null
}

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: { message?: string } | null
  }>
}

export class BrokerWriteFenceError extends Error {
  constructor() {
    super("Broker writer authority changed. Retry the operation.")
    this.name = "BrokerWriteFenceError"
  }
}

function authority(row: BrokerWriterRow) {
  const provider = row.provider == null || row.provider === "" ? "fxsocket" : row.provider
  const sessionId = provider === "mtapi"
    ? String(row.mtapi_session_id ?? "").trim()
    : String(row.fxsocket_account_id ?? row.metaapi_account_id ?? "").trim()
  const epoch = Number(row.writer_epoch)
  // Unknown provider, stale epoch or a mid-switch account always refuse: those
  // are the states where a second writer must not get in. An account that is
  // stable but simply has no session yet is NOT a refusal — see leaseRequired.
  if (
    (provider !== "fxsocket" && provider !== "mtapi")
    || !Number.isSafeInteger(epoch)
    || epoch < 1
    || row.provider_transition_state !== "stable"
  ) throw new BrokerWriteFenceError()
  return { provider, sessionId, epoch, leaseRequired: sessionId.length > 0 }
}

export async function withBrokerWriteLease<T>(
  supabase: RpcClient,
  row: BrokerWriterRow,
  operation: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const expected = authority(row)
  if (!expected.leaseRequired) {
    // No session yet — a fresh connect, or an account reset before the
    // migration prompt runs again. Nothing can hold a lease on it (the
    // database refuses an empty expected session, so no other writer can have
    // acquired one), which means there is nothing to fence off. Run the
    // mutation directly; refusing here would block the very reconnect that
    // establishes the session.
    return mutate()
  }
  const { data, error } = await supabase.rpc("acquire_broker_write_lease", {
    p_broker_account_id: row.id,
    p_expected_provider: expected.provider,
    p_expected_session_id: expected.sessionId,
    p_expected_writer_epoch: expected.epoch,
    p_operation: operation,
    p_ttl_seconds: 120,
  })
  const leaseRow = Array.isArray(data) ? data[0] : data
  const leaseId = String(
    (leaseRow as { lease_id?: unknown } | null)?.lease_id ?? "",
  ).trim()
  if (error || !leaseId) throw new BrokerWriteFenceError()

  let leaseValid = true
  let renewing = false
  const timer = setInterval(() => {
    if (renewing || !leaseValid) return
    renewing = true
    void Promise.resolve(supabase.rpc("renew_broker_write_lease", {
      p_lease_id: leaseId,
      p_ttl_seconds: 120,
    })).then(({ data, error }) => {
      if (error || data !== true) leaseValid = false
    }).catch(() => {
      leaseValid = false
    }).finally(() => {
      renewing = false
    })
  }, 30_000)

  try {
    const result = await mutate()
    if (!leaseValid) throw new BrokerWriteFenceError()
    return result
  } finally {
    clearInterval(timer)
    try {
      await supabase.rpc("release_broker_write_lease", { p_lease_id: leaseId })
    } catch {
      // Lease expiry is the final fail-safe if release transport fails.
    }
  }
}
