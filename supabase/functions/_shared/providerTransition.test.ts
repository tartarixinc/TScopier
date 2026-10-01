import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  ProviderTransitionError,
  mtapiAccountModeFromSummary,
  transitionBrokerProvider,
  type ProviderTransitionDeps,
  type ProviderTransitionRow,
} from "./providerTransition.ts"

function baseRow(overrides: Partial<ProviderTransitionRow> = {}): ProviderTransitionRow {
  return {
    id: "broker-1",
    provider: "fxsocket",
    writer_epoch: 1,
    provider_transition_state: "stable",
    provider_transition_target: null,
    mtapi_session_id: "mtapi-secret-session",
    mtapi_status: "connected",
    broker_password_encrypted: "v1:encrypted-secret",
    fxsocket_account_id: "fxsocket-preserved",
    metaapi_account_id: "legacy-preserved",
    platform: "MT5",
    ...overrides,
  }
}

function harness(initial = baseRow()) {
  let accountMode: "hedging" | "netting" | "unknown" = "hedging"
  let row = { ...initial }
  let oldLeases = 0
  let verifyCalls = 0
  let failVerifyAt = 0
  let finishAfterCommitError = false
  const logs: Array<Record<string, unknown>> = []
  const deps: ProviderTransitionDeps = {
    async load(id) { return id === row.id ? { ...row } : null },
    async verifyMtapi() {
      verifyCalls += 1
      if (failVerifyAt === verifyCalls) throw new Error("verify failed")
      return { accountMode }
    },
    async begin(args) {
      if (
        row.provider_transition_state !== "stable"
        || row.provider !== args.expectedProvider
        || row.writer_epoch !== args.expectedWriterEpoch
      ) throw new Error("concurrent transition")
      row = {
        ...row,
        writer_epoch: row.writer_epoch + 1,
        provider_transition_state: "transition",
        provider_transition_target: args.targetProvider,
      }
      return row.writer_epoch
    },
    async countOldLeases() { return oldLeases },
    async finish(args) {
      if (
        row.provider_transition_state !== "transition"
        || row.writer_epoch !== args.transitionWriterEpoch
        || oldLeases !== 0
      ) throw new Error("finish rejected")
      row = {
        ...row,
        provider: args.targetProvider,
        provider_transition_state: "stable",
        provider_transition_target: null,
      }
      if (finishAfterCommitError) throw new Error("lost response")
      return row.writer_epoch
    },
    async abort(args) {
      if (
        row.provider === args.expectedProvider
        && row.provider_transition_state === "transition"
        && row.writer_epoch === args.transitionWriterEpoch
      ) {
        row = { ...row, provider_transition_state: "stable", provider_transition_target: null }
        return true
      }
      return false
    },
    async sleep() {},
    log(event, fields) { logs.push({ event, ...fields }) },
  }
  return {
    deps,
    setAccountMode(value: "hedging" | "netting" | "unknown") { accountMode = value },
    logs,
    get row() { return row },
    get verifyCalls() { return verifyCalls },
    setOldLeases(value: number) { oldLeases = value },
    failVerifyAt(value: number) { failVerifyAt = value },
    failFinishAfterCommit() { finishAfterCommitError = true },
  }
}

Deno.test("activation flips the same row only after two MTAPI checks and preserves both sessions", async () => {
  const h = harness()
  const result = await transitionBrokerProvider(
    { brokerAccountId: "broker-1", targetProvider: "mtapi" },
    h.deps,
  )
  assertEquals(result, {
    id: "broker-1",
    provider: "mtapi",
    writer_epoch: 2,
    provider_transition_state: "stable",
    provider_transition_target: null,
  })
  assertEquals(h.verifyCalls, 2)
  assertEquals(h.row.fxsocket_account_id, "fxsocket-preserved")
  assertEquals(h.row.mtapi_session_id, "mtapi-secret-session")
  assert(!JSON.stringify({ result, logs: h.logs }).includes("mtapi-secret-session"))
  assert(!JSON.stringify({ result, logs: h.logs }).includes("encrypted-secret"))
})

Deno.test("post-begin verification failure aborts to stable FXSocket with bumped fence", async () => {
  const h = harness()
  h.failVerifyAt(2)
  await assertRejects(
    () => transitionBrokerProvider({ brokerAccountId: "broker-1", targetProvider: "mtapi" }, h.deps),
    ProviderTransitionError,
  )
  assertEquals(h.row.provider, "fxsocket")
  assertEquals(h.row.provider_transition_state, "stable")
  assertEquals(h.row.writer_epoch, 2)
})

Deno.test("rollback uses the same epoch fence and preserves the prepared MTAPI session", async () => {
  const h = harness(baseRow({ provider: "mtapi", writer_epoch: 4 }))
  const result = await transitionBrokerProvider(
    { brokerAccountId: "broker-1", targetProvider: "fxsocket" },
    h.deps,
  )
  assertEquals(result.provider, "fxsocket")
  assertEquals(result.writer_epoch, 5)
  assertEquals(h.row.mtapi_session_id, "mtapi-secret-session")
  assertEquals(h.row.fxsocket_account_id, "fxsocket-preserved")
})

Deno.test("concurrent activation has one winner", async () => {
  const h = harness()
  const results = await Promise.allSettled([
    transitionBrokerProvider({ brokerAccountId: "broker-1", targetProvider: "mtapi" }, h.deps),
    transitionBrokerProvider({ brokerAccountId: "broker-1", targetProvider: "mtapi" }, h.deps),
  ])
  assertEquals(results.filter(r => r.status === "fulfilled").length, 1)
  assertEquals(results.filter(r => r.status === "rejected").length, 1)
  assertEquals(h.row.provider, "mtapi")
})

Deno.test("lost finish response is resolved by authoritative reread without rollback", async () => {
  const h = harness()
  h.failFinishAfterCommit()
  const result = await transitionBrokerProvider(
    { brokerAccountId: "broker-1", targetProvider: "mtapi" },
    h.deps,
  )
  assertEquals(result.provider, "mtapi")
  assertEquals(h.row.provider_transition_state, "stable")
})

Deno.test("MT5 hedging activation is accepted", async () => {
  const h = harness()
  h.setAccountMode("hedging")
  const result = await transitionBrokerProvider(
    { brokerAccountId: "broker-1", targetProvider: "mtapi" },
    h.deps,
  )
  assertEquals(result.provider, "mtapi")
})

Deno.test("MT5 netting activation is rejected before provider cutover", async () => {
  const h = harness()
  h.setAccountMode("netting")
  const error = await assertRejects(
    () => transitionBrokerProvider({ brokerAccountId: "broker-1", targetProvider: "mtapi" }, h.deps),
    ProviderTransitionError,
  )
  assertEquals(error.code, "MT5_NETTING_UNSUPPORTED")
  assertEquals(h.row.provider, "fxsocket")
  assertEquals(h.row.writer_epoch, 1)
})

Deno.test("MT5 activation fails closed when account mode is unavailable", async () => {
  const h = harness()
  h.setAccountMode("unknown")
  const error = await assertRejects(
    () => transitionBrokerProvider({ brokerAccountId: "broker-1", targetProvider: "mtapi" }, h.deps),
    ProviderTransitionError,
  )
  assertEquals(error.code, "MT5_ACCOUNT_MODE_UNAVAILABLE")
  assertEquals(h.row.provider, "fxsocket")
})

Deno.test("MT4 activation does not require an MT5 account mode", async () => {
  const h = harness(baseRow({ platform: "MT4" }))
  h.setAccountMode("unknown")
  const result = await transitionBrokerProvider(
    { brokerAccountId: "broker-1", targetProvider: "mtapi" },
    h.deps,
  )
  assertEquals(result.provider, "mtapi")
})

Deno.test("account mode parser uses the authoritative MTAPI summary method", () => {
  assertEquals(mtapiAccountModeFromSummary({ method: "Hedging" }), "hedging")
  assertEquals(mtapiAccountModeFromSummary({ Method: "Netting" }), "netting")
  assertEquals(mtapiAccountModeFromSummary({ method: "Exchange" }), "netting")
  assertEquals(mtapiAccountModeFromSummary({}), "unknown")
})
