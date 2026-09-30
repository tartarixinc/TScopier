import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  MtapiPreparationError,
  prepareMtapiMigration,
  type MtapiPreparationBrokerRow,
  type MtapiPreparationDependencies,
  type MtapiPreparationPatch,
} from "./mtapiPreparation.ts"

function broker(overrides: Partial<MtapiPreparationBrokerRow> = {}): MtapiPreparationBrokerRow {
  return {
    id: "broker-1",
    user_id: "user-1",
    provider: "fxsocket",
    account_login: "123456",
    broker_server: "Broker-Live",
    platform: "MT5",
    fxsocket_account_id: "fxsocket-1",
    mtapi_session_id: null,
    label: "Primary",
    ...overrides,
  }
}

function harness(initial = broker()) {
  const rows = new Map<string, MtapiPreparationBrokerRow>([[initial.id, { ...initial }]])
  const connected: Array<Record<string, unknown>> = []
  const disconnected: string[] = []
  const patches: MtapiPreparationPatch[] = []
  let nextSession = "mtapi-new"
  let encrypt = async (_password: string) => "v1:iv:ciphertext"
  let connect = async (args: Record<string, unknown>) => {
    connected.push(args)
    return nextSession
  }
  let checkConnected = async (_sessionId: string) => {}
  let accountSummary: (sessionId: string) => Promise<Record<string, unknown>> = async () => ({ balance: 1000, login: 123456 })
  let persistFailure: Error | null = null

  const deps: MtapiPreparationDependencies = {
    async loadOwnedBroker(id, userId) {
      const row = rows.get(id)
      return row?.user_id === userId ? { ...row } : null
    },
    encryptPassword(password) {
      return encrypt(password)
    },
    connect(args) {
      return connect(args)
    },
    checkConnected(sessionId) {
      return checkConnected(sessionId)
    },
    accountSummary(sessionId) {
      return accountSummary(sessionId)
    },
    async persist(args) {
      if (persistFailure) throw persistFailure
      const row = rows.get(args.brokerAccountId)
      if (
        !row || row.user_id !== args.userId || row.provider !== "fxsocket"
        || row.mtapi_session_id !== args.expectedSessionId
      ) return null
      patches.push({ ...args.patch })
      const updated = { ...row, ...args.patch }
      rows.set(row.id, updated)
      return { ...updated }
    },
    async disconnect(sessionId) {
      disconnected.push(sessionId)
    },
    now: () => "2026-09-29T10:00:00.000Z",
  }

  return {
    rows,
    connected,
    disconnected,
    patches,
    deps,
    setSession(value: string) { nextSession = value },
    setEncrypt(fn: typeof encrypt) { encrypt = fn },
    setConnect(fn: typeof connect) { connect = fn },
    setCheck(fn: typeof checkConnected) { checkConnected = fn },
    setSummary(fn: typeof accountSummary) { accountSummary = fn },
    setPersistFailure(error: Error | null) { persistFailure = error },
  }
}

async function failure(promise: Promise<unknown>, code: string): Promise<MtapiPreparationError> {
  try {
    await promise
  } catch (error) {
    assert(error instanceof MtapiPreparationError)
    assertEquals(error.code, code)
    return error
  }
  throw new Error(`Expected ${code}`)
}

Deno.test("same-row preparation preserves identity, provider, FXSocket state, and browser secrecy", async () => {
  const h = harness()
  const result = await prepareMtapiMigration({
    brokerAccountId: "broker-1",
    userId: "user-1",
    accountPassword: " password with spaces ",
  }, h.deps)

  const stored = h.rows.get("broker-1")!
  assertEquals(h.rows.size, 1)
  assertEquals(stored.id, "broker-1")
  assertEquals(stored.provider, "fxsocket")
  assertEquals(stored.fxsocket_account_id, "fxsocket-1")
  assertEquals(stored.mtapi_session_id, "mtapi-new")
  assertEquals(stored.broker_password_encrypted, "v1:iv:ciphertext")
  assertEquals(stored.auto_reconnect_enabled, true)
  assertEquals(stored.mtapi_status, "connected")
  assertEquals(stored.label, "Primary")
  assertEquals(h.patches.length, 1)
  assertEquals(h.connected, [{
    server: "Broker-Live",
    login: "123456",
    password: " password with spaces ",
    platform: "MT5",
  }])
  assertEquals(result.summary.balance, 1000)
  assertEquals("mtapi_session_id" in result.account, false)
  assertEquals("broker_password_encrypted" in result.account, false)
})

Deno.test("preparation uses canonical row credentials and accepts canonical MT4", async () => {
  const h = harness(broker({
    account_login: "4444",
    broker_server: "Canonical-MT4",
    platform: "mt4",
  }))
  await prepareMtapiMigration({
    brokerAccountId: "broker-1",
    userId: "user-1",
    accountPassword: "secret",
  }, h.deps)
  assertEquals(h.connected[0], {
    server: "Canonical-MT4",
    login: "4444",
    password: "secret",
    platform: "MT4",
  })
})

Deno.test("wrong owner cannot prepare another user's broker", async () => {
  const h = harness()
  await failure(prepareMtapiMigration({
    brokerAccountId: "broker-1",
    userId: "other-user",
    accountPassword: "secret",
  }, h.deps), "ACCOUNT_NOT_FOUND")
  assertEquals(h.connected.length, 0)
  assertEquals(h.rows.get("broker-1")?.provider, "fxsocket")
})

Deno.test("non-FXSocket rows cannot enter the preparation path", async () => {
  const h = harness(broker({ provider: "mtapi" }))
  await failure(prepareMtapiMigration({
    brokerAccountId: "broker-1",
    userId: "user-1",
    accountPassword: "secret",
  }, h.deps), "PROVIDER_NOT_FXSOCKET")
  assertEquals(h.connected.length, 0)
})

Deno.test("missing or failed encryption fails closed before MTAPI connect", async () => {
  for (const mode of ["throws", "plaintext", "empty"] as const) {
    const h = harness()
    h.setEncrypt(async (password) => {
      if (mode === "throws") throw new Error("key unavailable")
      return mode === "plaintext" ? password : ""
    })
    await failure(prepareMtapiMigration({
      brokerAccountId: "broker-1",
      userId: "user-1",
      accountPassword: "secret",
    }, h.deps), "CREDENTIAL_ENCRYPTION_FAILED")
    assertEquals(h.connected.length, 0)
    assertEquals(h.rows.get("broker-1")?.broker_password_encrypted, undefined)
  }
})

Deno.test("invalid canonical broker fields fail before encryption or connect", async () => {
  const cases: Array<[Partial<MtapiPreparationBrokerRow>, string]> = [
    [{ account_login: null }, "LOGIN_MISSING"],
    [{ broker_server: "" }, "SERVER_MISSING"],
    [{ platform: "MT6" }, "PLATFORM_INVALID"],
  ]
  for (const [overrides, code] of cases) {
    const h = harness(broker(overrides))
    let encrypted = false
    h.setEncrypt(async () => {
      encrypted = true
      return "v1:iv:ciphertext"
    })
    await failure(prepareMtapiMigration({
      brokerAccountId: "broker-1",
      userId: "user-1",
      accountPassword: "secret",
    }, h.deps), code)
    assertEquals(encrypted, false)
    assertEquals(h.connected.length, 0)
  }
})

Deno.test("authentication, outage, timeout, and malformed session leave FXSocket state untouched", async () => {
  const cases = [
    async () => { throw new Error("wrong password") },
    async () => { throw new Error("unavailable") },
    async () => { throw new DOMException("timeout", "AbortError") },
    async () => "",
  ]
  for (const connect of cases) {
    const h = harness()
    h.setConnect(connect)
    const expected = connect === cases[3] ? "MTAPI_SESSION_INVALID" : "MTAPI_CONNECT_FAILED"
    await failure(prepareMtapiMigration({
      brokerAccountId: "broker-1",
      userId: "user-1",
      accountPassword: "secret",
    }, h.deps), expected)
    const stored = h.rows.get("broker-1")!
    assertEquals(stored.provider, "fxsocket")
    assertEquals(stored.fxsocket_account_id, "fxsocket-1")
    assertEquals(stored.mtapi_session_id, null)
  }
})

Deno.test("CheckConnect and AccountSummary failures clean up the new session", async () => {
  for (const stage of ["check", "summary"] as const) {
    const h = harness()
    if (stage === "check") h.setCheck(async () => { throw new Error("not connected") })
    else h.setSummary(async () => ({}))
    await failure(prepareMtapiMigration({
      brokerAccountId: "broker-1",
      userId: "user-1",
      accountPassword: "secret",
    }, h.deps), "MTAPI_VERIFICATION_FAILED")
    assertEquals(h.disconnected, ["mtapi-new"])
    assertEquals(h.rows.get("broker-1")?.mtapi_session_id, null)
  }
})

Deno.test("DB persistence failure cleans the new session without changing the row", async () => {
  const h = harness()
  h.setPersistFailure(new Error("database unavailable"))
  await failure(prepareMtapiMigration({
    brokerAccountId: "broker-1",
    userId: "user-1",
    accountPassword: "secret",
  }, h.deps), "PREPARATION_PERSIST_FAILED")
  assertEquals(h.disconnected, ["mtapi-new"])
  assertEquals(h.rows.get("broker-1")?.mtapi_session_id, null)
  assertEquals(h.rows.get("broker-1")?.provider, "fxsocket")
})

Deno.test("re-preparation replaces credentials and session without a duplicate row", async () => {
  const h = harness()
  await prepareMtapiMigration({ brokerAccountId: "broker-1", userId: "user-1", accountPassword: "first" }, h.deps)
  h.setSession("mtapi-second")
  h.setEncrypt(async () => "v1:iv:replacement")
  await prepareMtapiMigration({ brokerAccountId: "broker-1", userId: "user-1", accountPassword: "second" }, h.deps)

  const stored = h.rows.get("broker-1")!
  assertEquals(h.rows.size, 1)
  assertEquals(stored.id, "broker-1")
  assertEquals(stored.provider, "fxsocket")
  assertEquals(stored.mtapi_session_id, "mtapi-second")
  assertEquals(stored.broker_password_encrypted, "v1:iv:replacement")
  assertEquals(h.disconnected, ["mtapi-new"])
})

Deno.test("ambiguous persistence response is recovered when the committed row is observable", async () => {
  const h = harness()
  h.deps.persist = async (args) => {
    const current = h.rows.get(args.brokerAccountId)
    assert(current)
    h.rows.set(current.id, { ...current, ...args.patch })
    throw new Error("response lost after commit")
  }

  const result = await prepareMtapiMigration({ brokerAccountId: "broker-1", userId: "user-1", accountPassword: "secret" }, h.deps)
  const stored = h.rows.get("broker-1")!
  assertEquals(stored.mtapi_session_id, "mtapi-new")
  assertEquals(stored.provider, "fxsocket")
  assertEquals(result.account.id, "broker-1")
  assertEquals(h.disconnected, [])
})

Deno.test("unknown persistence outcome does not disconnect a session the row may reference", async () => {
  const h = harness()
  const load = h.deps.loadOwnedBroker.bind(h.deps)
  let loads = 0
  h.deps.loadOwnedBroker = async (id, userId) => {
    loads++
    if (loads > 1) throw new Error("database unavailable")
    return load(id, userId)
  }
  h.deps.persist = async () => { throw new Error("response lost") }
  await failure(prepareMtapiMigration({ brokerAccountId: "broker-1", userId: "user-1", accountPassword: "secret" }, h.deps), "PREPARATION_PERSIST_UNKNOWN")
  assertEquals(h.disconnected, [])
})

Deno.test("verification failure never disconnects a previously stored session token", async () => {
  const h = harness(broker({ mtapi_session_id: "mtapi-new" }))
  h.setCheck(async () => { throw new Error("temporary check failure") })
  await failure(prepareMtapiMigration({ brokerAccountId: "broker-1", userId: "user-1", accountPassword: "secret" }, h.deps), "MTAPI_VERIFICATION_FAILED")
  assertEquals(h.disconnected, [])
  assertEquals(h.rows.get("broker-1")?.mtapi_session_id, "mtapi-new")
})

Deno.test("a reused token alone cannot masquerade as a committed credential update", async () => {
  const h = harness(broker({ mtapi_session_id: "mtapi-new", broker_password_encrypted: "v1:iv:old" }))
  h.deps.persist = async () => { throw new Error("response lost before commit") }
  await failure(prepareMtapiMigration({ brokerAccountId: "broker-1", userId: "user-1", accountPassword: "changed" }, h.deps), "PREPARATION_PERSIST_FAILED")
  assertEquals(h.rows.get("broker-1")?.broker_password_encrypted, "v1:iv:old")
  assertEquals(h.disconnected, [])
})
