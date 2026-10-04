export type MtapiPreparationPlatform = "MT4" | "MT5"

export type MtapiPreparationBrokerRow = Record<string, unknown> & {
  id: string
  user_id: string
  provider: string | null
  account_login: string | null
  broker_server: string | null
  platform: string | null
  fxsocket_account_id: string | null
  mtapi_session_id: string | null
  writer_epoch: number
  provider_transition_state: "stable" | "transition"
}

export type MtapiPreparationPatch = {
  mtapi_session_id: string
  broker_password_encrypted: string
  auto_reconnect_enabled: true
  mtapi_status: "connected"
  password_updated_at: string
}

export class MtapiPreparationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = "MtapiPreparationError"
  }
}

export type MtapiPreparationDependencies = {
  loadOwnedBroker(brokerAccountId: string, userId: string): Promise<MtapiPreparationBrokerRow | null>
  encryptPassword(password: string): Promise<string>
  connect(args: {
    server: string
    login: string
    password: string
    platform: MtapiPreparationPlatform
  }): Promise<string>
  checkConnected(sessionId: string, platform: MtapiPreparationPlatform): Promise<void>
  accountSummary(sessionId: string, platform: MtapiPreparationPlatform): Promise<Record<string, unknown>>
  persist(args: {
    brokerAccountId: string
    userId: string
    expectedSessionId: string | null
    patch: MtapiPreparationPatch
    expectedWriterEpoch: number
  }): Promise<MtapiPreparationBrokerRow | null>
  disconnect(sessionId: string, platform: MtapiPreparationPlatform): Promise<void>
  now(): string
}

export type PrepareMtapiMigrationInput = {
  brokerAccountId: string
  userId: string
  accountPassword: string
}

export type PrepareMtapiMigrationResult = {
  account: Record<string, unknown>
  summary: Record<string, unknown>
}

export function stripMtapiPreparationSecrets(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const {
    broker_password_encrypted: _password,
    mtapi_session_id: _session,
    ...safe
  } = row
  return safe
}

function preparationError(
  message: string,
  status: number,
  code: string,
): MtapiPreparationError {
  return new MtapiPreparationError(message, status, code)
}

async function cleanupSession(
  deps: MtapiPreparationDependencies,
  sessionId: string,
  platform: MtapiPreparationPlatform,
): Promise<void> {
  try {
    await deps.disconnect(sessionId, platform)
  } catch {
    // Best effort only. Preserve the original error and never expose a
    // session identifier through cleanup failures.
  }
}

/** Prepare an existing FXSocket row for a later writer cutover. */
export async function prepareMtapiMigration(
  input: PrepareMtapiMigrationInput,
  deps: MtapiPreparationDependencies,
): Promise<PrepareMtapiMigrationResult> {
  const brokerAccountId = input.brokerAccountId.trim()
  const userId = input.userId.trim()
  const password = input.accountPassword
  if (!brokerAccountId) throw preparationError("broker_account_id required", 400, "ACCOUNT_ID_REQUIRED")
  if (!password.trim()) throw preparationError("account_password required", 400, "PASSWORD_REQUIRED")

  const row = await deps.loadOwnedBroker(brokerAccountId, userId)
  if (!row) throw preparationError("Broker account not found", 404, "ACCOUNT_NOT_FOUND")
  if (row.provider !== "fxsocket") {
    throw preparationError(
      "Only an FXSocket broker account can be prepared for MTAPI migration.",
      409,
      "PROVIDER_NOT_FXSOCKET",
    )
  }
  if (
    row.provider_transition_state !== "stable"
    || !Number.isSafeInteger(row.writer_epoch)
    || row.writer_epoch < 1
  ) {
    throw preparationError("Broker provider transition is in progress.", 409, "PROVIDER_TRANSITION_ACTIVE")
  }

  const login = String(row.account_login ?? "").trim()
  const server = String(row.broker_server ?? "").trim()
  const platformRaw = String(row.platform ?? "").trim().toUpperCase()
  if (!login) throw preparationError("Broker login is missing.", 409, "LOGIN_MISSING")
  if (!server) throw preparationError("Broker server is missing.", 409, "SERVER_MISSING")
  if (platformRaw !== "MT4" && platformRaw !== "MT5") {
    throw preparationError("Broker platform must be MT4 or MT5.", 409, "PLATFORM_INVALID")
  }
  const platform = platformRaw as MtapiPreparationPlatform

  let encryptedPassword: string
  try {
    encryptedPassword = await deps.encryptPassword(password)
  } catch {
    throw preparationError(
      "Broker credential encryption is unavailable.",
      503,
      "CREDENTIAL_ENCRYPTION_FAILED",
    )
  }
  if (!encryptedPassword || !encryptedPassword.startsWith("v1:") || encryptedPassword === password) {
    throw preparationError(
      "Broker credential encryption is unavailable.",
      503,
      "CREDENTIAL_ENCRYPTION_FAILED",
    )
  }

  let newSessionId = ""
  const oldSessionId = String(row.mtapi_session_id ?? "").trim()
  let cleanupNewSessionOnFailure = true
  try {
    try {
      newSessionId = String(await deps.connect({ server, login, password, platform })).trim()
    } catch {
      throw preparationError(
        "MTAPI authentication failed or the service is unavailable.",
        503,
        "MTAPI_CONNECT_FAILED",
      )
    }
    if (!newSessionId) {
      throw preparationError(
        "MTAPI returned an invalid session.",
        502,
        "MTAPI_SESSION_INVALID",
      )
    }

    let summary: Record<string, unknown>
    try {
      await deps.checkConnected(newSessionId, platform)
      summary = await deps.accountSummary(newSessionId, platform)
      if (!summary || Object.keys(summary).length === 0) throw new Error("empty summary")
    } catch {
      throw preparationError(
        "MTAPI connection verification failed.",
        502,
        "MTAPI_VERIFICATION_FAILED",
      )
    }

    let persisted: MtapiPreparationBrokerRow | null
    try {
      persisted = await deps.persist({
        brokerAccountId: row.id,
        userId,
        expectedSessionId: row.mtapi_session_id,
        expectedWriterEpoch: row.writer_epoch,
        patch: {
          mtapi_session_id: newSessionId,
          broker_password_encrypted: encryptedPassword,
          auto_reconnect_enabled: true,
          mtapi_status: "connected",
          password_updated_at: deps.now(),
        },
      })
    } catch {
      // A transport failure can be ambiguous: the update may have committed
      // even though its response was lost. Re-read before disconnecting the
      // new session so a committed row is never left pointing at a dead token.
      try {
        const observed = await deps.loadOwnedBroker(row.id, userId)
        if (
          observed?.provider === "fxsocket"
          && observed.mtapi_session_id === newSessionId
          && observed.broker_password_encrypted === encryptedPassword
        ) {
          persisted = observed
        } else {
          throw preparationError(
            "Unable to save MTAPI migration preparation.",
            500,
            "PREPARATION_PERSIST_FAILED",
          )
        }
      } catch (error) {
        if (!(error instanceof MtapiPreparationError)) cleanupNewSessionOnFailure = false
        throw error instanceof MtapiPreparationError
          ? error
          : preparationError("Unable to verify MTAPI migration persistence.", 500, "PREPARATION_PERSIST_UNKNOWN")
      }
    }
    if (!persisted) {
      throw preparationError(
        "Broker preparation changed concurrently. Try again.",
        409,
        "PREPARATION_CONFLICT",
      )
    }
    if (persisted.id !== row.id || persisted.provider !== "fxsocket") {
      throw preparationError(
        "Broker preparation did not preserve the active provider.",
        500,
        "PROVIDER_INVARIANT_FAILED",
      )
    }

    if (oldSessionId && oldSessionId !== newSessionId) {
      await cleanupSession(deps, oldSessionId, platform)
    }

    return { account: stripMtapiPreparationSecrets(persisted), summary }
  } catch (error) {
    if (newSessionId && newSessionId !== oldSessionId && cleanupNewSessionOnFailure) {
      await cleanupSession(deps, newSessionId, platform)
    }
    if (error instanceof MtapiPreparationError) throw error
    throw preparationError("MTAPI migration preparation failed.", 500, "PREPARATION_FAILED")
  }
}
