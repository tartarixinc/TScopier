import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  BrokerWriteFenceError,
  withBrokerWriteLease,
  type BrokerWriterRow,
} from "./brokerWriteLease.ts"

const stableFx: BrokerWriterRow = {
  id: "11111111-1111-1111-1111-111111111111",
  provider: "fxsocket",
  fxsocket_account_id: "fx-session",
  writer_epoch: 7,
  provider_transition_state: "stable",
}

Deno.test("edge write lease passes provider, session, and epoch then releases", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args })
      if (name === "acquire_broker_write_lease") {
        return { data: [{ lease_id: "22222222-2222-2222-2222-222222222222" }], error: null }
      }
      return { data: true, error: null }
    },
  }
  let mutations = 0
  const result = await withBrokerWriteLease(client, stableFx, "edge_reconnect", async () => {
    mutations += 1
    return "ok"
  })

  assertEquals(result, "ok")
  assertEquals(mutations, 1)
  assertEquals(calls[0], {
    name: "acquire_broker_write_lease",
    args: {
      p_broker_account_id: stableFx.id,
      p_expected_provider: "fxsocket",
      p_expected_session_id: "fx-session",
      p_expected_writer_epoch: 7,
      p_operation: "edge_reconnect",
      p_ttl_seconds: 120,
    },
  })
  assertEquals(calls.at(-1)?.name, "release_broker_write_lease")
})

Deno.test("edge write lease blocks transition state before mutation", async () => {
  let rpcCalls = 0
  let mutations = 0
  await assertRejects(
    () => withBrokerWriteLease(
      { rpc() { rpcCalls += 1; return Promise.resolve({ data: null, error: null }) } },
      { ...stableFx, provider_transition_state: "transition" },
      "edge_reconnect",
      async () => { mutations += 1 },
    ),
    BrokerWriteFenceError,
  )
  assertEquals(rpcCalls, 0)
  assertEquals(mutations, 0)
})

Deno.test("edge write lease rejects stale authority before external mutation", async () => {
  let mutations = 0
  await assertRejects(
    () => withBrokerWriteLease(
      { rpc() { return Promise.resolve({ data: null, error: { message: "stale" } }) } },
      stableFx,
      "edge_reconnect",
      async () => { mutations += 1 },
    ),
    BrokerWriteFenceError,
  )
  assertEquals(mutations, 0)
})

Deno.test("edge write lease runs unleased for a stable account with no session yet", async () => {
  // A fresh connect, or an account reset before the migration prompt runs
  // again: nothing can hold a lease on a session-less account, so refusing
  // would block the reconnect that establishes the session.
  let rpcCalls = 0
  const row: BrokerWriterRow = {
    id: "33333333-3333-3333-3333-333333333333",
    provider: "mtapi",
    mtapi_session_id: null,
    writer_epoch: 1,
    provider_transition_state: "stable",
  }
  const result = await withBrokerWriteLease(
    { rpc() { rpcCalls += 1; return Promise.resolve({ data: null, error: null }) } },
    row,
    "mtapi_reconnect",
    async () => "reconnected",
  )
  assertEquals(result, "reconnected")
  assertEquals(rpcCalls, 0)
})

Deno.test("edge write lease still refuses a session-less account that is mid-switch", async () => {
  let rpcCalls = 0
  let mutations = 0
  await assertRejects(
    () => withBrokerWriteLease(
      { rpc() { rpcCalls += 1; return Promise.resolve({ data: null, error: null }) } },
      {
        id: "44444444-4444-4444-4444-444444444444",
        provider: "mtapi",
        mtapi_session_id: null,
        writer_epoch: 3,
        provider_transition_state: "transition",
      },
      "mtapi_reconnect",
      async () => { mutations += 1 },
    ),
    BrokerWriteFenceError,
  )
  assertEquals(rpcCalls, 0)
  assertEquals(mutations, 0)
})
