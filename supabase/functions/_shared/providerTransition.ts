export type BrokerProviderName = "fxsocket" | "mtapi"

export type ProviderTransitionRow = {
  id: string
  provider: BrokerProviderName
  writer_epoch: number
  provider_transition_state: "stable" | "transition"
  provider_transition_target: BrokerProviderName | null
  mtapi_session_id: string | null
  mtapi_status: string | null
  broker_password_encrypted: string | null
  fxsocket_account_id: string | null
  metaapi_account_id?: string | null
  platform: string | null
}

export type ProviderTransitionDeps = {
  load(brokerAccountId: string): Promise<ProviderTransitionRow | null>
  verifyMtapi(sessionId: string, platform: "MT4" | "MT5"): Promise<void>
  begin(args: {
    brokerAccountId: string
    expectedProvider: BrokerProviderName
    targetProvider: BrokerProviderName
    expectedSessionId: string
    expectedWriterEpoch: number
  }): Promise<number>
  countOldLeases(brokerAccountId: string, transitionWriterEpoch: number): Promise<number>
  finish(args: {
    brokerAccountId: string
    expectedProvider: BrokerProviderName
    targetProvider: BrokerProviderName
    transitionWriterEpoch: number
  }): Promise<number>
  abort(args: {
    brokerAccountId: string
    expectedProvider: BrokerProviderName
    targetProvider: BrokerProviderName
    transitionWriterEpoch: number
  }): Promise<boolean>
  sleep(ms: number): Promise<void>
  log(event: string, fields: Record<string, unknown>): void
}

export class ProviderTransitionError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = "PROVIDER_TRANSITION_REJECTED",
  ) {
    super(message)
    this.name = "ProviderTransitionError"
  }
}

function sessionFor(row: ProviderTransitionRow, provider: BrokerProviderName): string {
  return provider === "mtapi"
    ? String(row.mtapi_session_id ?? "").trim()
    : String(row.fxsocket_account_id ?? row.metaapi_account_id ?? "").trim()
}

function platformOf(row: ProviderTransitionRow): "MT4" | "MT5" {
  const value = String(row.platform ?? "").toUpperCase()
  if (value !== "MT4" && value !== "MT5") {
    throw new ProviderTransitionError("Broker platform is invalid.", 409, "PLATFORM_INVALID")
  }
  return value
}

function publicResult(row: ProviderTransitionRow) {
  return {
    id: row.id,
    provider: row.provider,
    writer_epoch: row.writer_epoch,
    provider_transition_state: row.provider_transition_state,
    provider_transition_target: row.provider_transition_target,
  }
}

export async function transitionBrokerProvider(
  input: {
    brokerAccountId: string
    targetProvider: BrokerProviderName
    drainTimeoutMs?: number
    drainPollMs?: number
  },
  deps: ProviderTransitionDeps,
) {
  const brokerAccountId = input.brokerAccountId.trim()
  if (!brokerAccountId) {
    throw new ProviderTransitionError("broker_account_id required", 400, "ACCOUNT_ID_REQUIRED")
  }
  const initial = await deps.load(brokerAccountId)
  if (!initial) throw new ProviderTransitionError("Broker account not found.", 404, "ACCOUNT_NOT_FOUND")
  const expectedProvider = initial.provider
  const targetProvider = input.targetProvider
  if (expectedProvider === targetProvider) {
    throw new ProviderTransitionError("Broker already uses the target provider.", 409, "ALREADY_ACTIVE")
  }
  if (initial.provider_transition_state !== "stable" || initial.provider_transition_target !== null) {
    throw new ProviderTransitionError("Broker provider transition is already active.", 409, "TRANSITION_ACTIVE")
  }
  if (!Number.isSafeInteger(initial.writer_epoch) || initial.writer_epoch < 1) {
    throw new ProviderTransitionError("Broker writer epoch is invalid.", 409, "WRITER_EPOCH_INVALID")
  }
  const expectedSessionId = sessionFor(initial, expectedProvider)
  if (!expectedSessionId) {
    throw new ProviderTransitionError("Current provider session is missing.", 409, "CURRENT_SESSION_MISSING")
  }

  if (targetProvider === "mtapi") {
    const mtapiSession = sessionFor(initial, "mtapi")
    if (
      !mtapiSession
      || initial.mtapi_status !== "connected"
      || !String(initial.broker_password_encrypted ?? "").trim()
    ) {
      throw new ProviderTransitionError("MTAPI preparation is incomplete.", 409, "MTAPI_NOT_PREPARED")
    }
    await deps.verifyMtapi(mtapiSession, platformOf(initial))
  } else if (!sessionFor(initial, "fxsocket")) {
    throw new ProviderTransitionError("Preserved FXSocket session is missing.", 409, "FXSOCKET_SESSION_MISSING")
  }

  deps.log("provider_transition_requested", {
    broker_account_id: brokerAccountId,
    old_provider: expectedProvider,
    target_provider: targetProvider,
    writer_epoch: initial.writer_epoch,
  })

  let transitionEpoch: number | null = null
  let finishAttempted = false
  try {
    transitionEpoch = await deps.begin({
      brokerAccountId,
      expectedProvider,
      targetProvider,
      expectedSessionId,
      expectedWriterEpoch: initial.writer_epoch,
    })
    deps.log("provider_transition_entered", {
      broker_account_id: brokerAccountId,
      old_provider: expectedProvider,
      target_provider: targetProvider,
      writer_epoch: transitionEpoch,
    })

    const timeoutMs = Math.max(5_000, Math.min(input.drainTimeoutMs ?? 150_000, 300_000))
    const pollMs = Math.max(50, Math.min(input.drainPollMs ?? 250, 2_000))
    const deadline = Date.now() + timeoutMs
    while (await deps.countOldLeases(brokerAccountId, transitionEpoch) > 0) {
      if (Date.now() >= deadline) {
        throw new ProviderTransitionError("Broker writes did not drain before timeout.", 503, "WRITE_DRAIN_TIMEOUT")
      }
      await deps.sleep(pollMs)
    }

    const fenced = await deps.load(brokerAccountId)
    if (
      !fenced
      || fenced.provider !== expectedProvider
      || fenced.provider_transition_state !== "transition"
      || fenced.provider_transition_target !== targetProvider
      || fenced.writer_epoch !== transitionEpoch
    ) throw new ProviderTransitionError("Provider transition state changed unexpectedly.", 409, "TRANSITION_STATE_CHANGED")

    if (targetProvider === "mtapi") {
      const mtapiSession = sessionFor(fenced, "mtapi")
      if (
        !mtapiSession
        || fenced.mtapi_status !== "connected"
        || !String(fenced.broker_password_encrypted ?? "").trim()
      ) throw new ProviderTransitionError("MTAPI preparation changed during transition.", 409, "MTAPI_NOT_PREPARED")
      await deps.verifyMtapi(mtapiSession, platformOf(fenced))
    } else if (!sessionFor(fenced, "fxsocket")) {
      throw new ProviderTransitionError("Preserved FXSocket session changed during transition.", 409, "FXSOCKET_SESSION_MISSING")
    }

    finishAttempted = true
    await deps.finish({
      brokerAccountId,
      expectedProvider,
      targetProvider,
      transitionWriterEpoch: transitionEpoch,
    })
    const activated = await deps.load(brokerAccountId)
    if (!activated || activated.provider !== targetProvider || activated.provider_transition_state !== "stable") {
      throw new ProviderTransitionError("Provider activation result is ambiguous.", 503, "ACTIVATION_AMBIGUOUS")
    }
    deps.log(targetProvider === "fxsocket" ? "provider_rollback_activated" : "provider_activated", {
      broker_account_id: brokerAccountId,
      old_provider: expectedProvider,
      target_provider: targetProvider,
      writer_epoch: activated.writer_epoch,
    })
    return publicResult(activated)
  } catch (error) {
    if (transitionEpoch != null) {
      if (finishAttempted) {
        // The finish response may have been lost after commit. Observe before
        // deciding whether abort is legal; inability to observe stays fail-closed.
        let observed: ProviderTransitionRow | null
        try {
          observed = await deps.load(brokerAccountId)
        } catch {
          observed = null
        }
        if (observed?.provider === targetProvider && observed.provider_transition_state === "stable") {
          return publicResult(observed)
        }
        if (
          observed?.provider === expectedProvider
          && observed.provider_transition_state === "transition"
          && observed.provider_transition_target === targetProvider
          && observed.writer_epoch === transitionEpoch
        ) {
          await deps.abort({ brokerAccountId, expectedProvider, targetProvider, transitionWriterEpoch: transitionEpoch })
        }
      } else {
        await deps.abort({ brokerAccountId, expectedProvider, targetProvider, transitionWriterEpoch: transitionEpoch })
      }
    }
    deps.log("provider_transition_failed", {
      broker_account_id: brokerAccountId,
      old_provider: expectedProvider,
      target_provider: targetProvider,
      writer_epoch: transitionEpoch ?? initial.writer_epoch,
      error_code: error instanceof ProviderTransitionError ? error.code : "UNEXPECTED",
    })
    if (error instanceof ProviderTransitionError) throw error
    throw new ProviderTransitionError("Provider transition failed.", 500, "TRANSITION_FAILED")
  }
}
