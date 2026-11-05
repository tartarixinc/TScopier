import { assertEquals } from "jsr:@std/assert@1";
import { isReconcileDriftRow, reconnectRequiredUserIds, persistenceStep } from "./alertEvalRules.ts";

Deno.test("isReconcileDriftRow: drift/reconciliation diagnostics are excluded", () => {
  const reconcile = [
    "Reconcile: 1/1 legs; broker SL still drifted",
    "live position reconciliation required: stored ticket has no live position match",
    "close reconciliation required: stored ticket has no live position match",
    "automatic management reconciliation required: stored ticket has no live position match",
    "partial close reconciliation required: stored ticket has no live position match",
    "live position reconciliation required: attributes match multiple live positions",
    "live position reconciliation required: identity match is by attributes only; not persisted",
    // Bare phrases — kept aligned with worker/src/failureClassification.ts
    // (isUnresolvableFailure) so the alert and the worker agree on the class.
    "stored ticket maps to no live position match",
    "stored ticket maps to multiple live positions",
    "attributes match multiple live positions",
    "identity ambiguous",
    "RECONCILIATION REQUIRED",
  ];
  for (const msg of reconcile) {
    assertEquals(isReconcileDriftRow(msg), true, msg);
  }
});

Deno.test("isReconcileDriftRow: real execution failures still count", () => {
  const real = [
    "Market is closed",
    "Invalid stops in the request (:35936456)",
    "Trade is disabled",
    "Investor mode (:750002857)",
    "Invalid account",
    "INVALID_ACCOUNT (:62136328)",
    "There is not enough money to complete the request (:480484022)",
    "XAUUSD not exist",
    "Signal stop loss 3986 is on the wrong side of the live price",
    null,
    undefined,
    "",
  ];
  for (const msg of real) {
    assertEquals(isReconcileDriftRow(msg), false, String(msg));
  }
});

Deno.test("reconnectRequiredUserIds: only reconnect_required status is excluded", () => {
  const rows = [
    { user_id: "u1", telegram_account_status: "reconnect_required" },
    { user_id: "u2", telegram_account_status: "linked" },
    { user_id: "u3", telegram_account_status: "RECONNECT_REQUIRED" },
    { user_id: "u4", telegram_account_status: null },
    { user_id: "  ", telegram_account_status: "reconnect_required" },
    { user_id: "u5" },
  ];
  assertEquals([...reconnectRequiredUserIds(rows)].sort(), ["u1", "u3"]);
});

Deno.test("persistenceStep: persistMs 0 keeps legacy immediate behaviour", () => {
  assertEquals(persistenceStep({ persistMs: 0, fired: true, hasOpen: false, trueSince: null, falseSince: null, nowMs: 1000 }).action, "insert");
  assertEquals(persistenceStep({ persistMs: 0, fired: false, hasOpen: true, trueSince: null, falseSince: null, nowMs: 1000 }).action, "resolve");
  assertEquals(persistenceStep({ persistMs: 0, fired: true, hasOpen: true, trueSince: null, falseSince: null, nowMs: 1000 }).action, "none");
  assertEquals(persistenceStep({ persistMs: 0, fired: false, hasOpen: false, trueSince: null, falseSince: null, nowMs: 1000 }).action, "none");
  // No timers -> no column writes on legacy rules.
  assertEquals(persistenceStep({ persistMs: 0, fired: false, hasOpen: false, trueSince: null, falseSince: null, nowMs: 1000 }).patch, {});
});

Deno.test("persistenceStep: persistence switched off clears stale timers", () => {
  // threshold.persistence_minutes edited 2 -> 0 while a timer was armed.
  const clearFire = persistenceStep({ persistMs: 0, fired: true, hasOpen: false, trueSince: 5_000, falseSince: null, nowMs: 9_000 });
  assertEquals(clearFire.action, "insert");
  assertEquals(clearFire.patch, { cond_true_since: null, cond_false_since: null });
  const clearIdle = persistenceStep({ persistMs: 0, fired: false, hasOpen: false, trueSince: 5_000, falseSince: null, nowMs: 9_000 });
  assertEquals(clearIdle.action, "none");
  assertEquals(clearIdle.patch, { cond_true_since: null, cond_false_since: null });
});

Deno.test("persistenceStep: arms on first true tick without firing", () => {
  const step = persistenceStep({ persistMs: 120_000, fired: true, hasOpen: false, trueSince: null, falseSince: null, nowMs: 5_000 });
  assertEquals(step.action, "none");
  assertEquals(step.patch, { cond_true_since: 5_000 });
});

Deno.test("persistenceStep: fires only after holding for persistMs", () => {
  const armed = { persistMs: 120_000, fired: true, hasOpen: false, trueSince: 5_000, falseSince: null };
  assertEquals(persistenceStep({ ...armed, nowMs: 124_000 }).action, "none"); // 119s < 120s
  const fire = persistenceStep({ ...armed, nowMs: 125_000 }); // 120s exactly
  assertEquals(fire.action, "insert");
  assertEquals(fire.patch, { cond_true_since: null, cond_false_since: null });
});

Deno.test("persistenceStep: a false tick while arming resets the timer", () => {
  const armed = { persistMs: 120_000, fired: true, hasOpen: false, trueSince: 5_000, falseSince: null };
  const clear = persistenceStep({ ...armed, fired: false, nowMs: 60_000 });
  assertEquals(clear.action, "none");
  assertEquals(clear.patch, { cond_true_since: null, cond_false_since: null });
  // Re-true afterwards starts over from the new tick.
  const rearm = persistenceStep({ persistMs: 120_000, fired: true, hasOpen: false, trueSince: null, falseSince: null, nowMs: 70_000 });
  assertEquals(rearm.patch, { cond_true_since: 70_000 });
});

Deno.test("persistenceStep: holds the open event until clear persists", () => {
  const open = { persistMs: 120_000, fired: false, hasOpen: true, trueSince: null };
  const arm = persistenceStep({ ...open, falseSince: null, nowMs: 10_000 });
  assertEquals(arm.action, "none");
  assertEquals(arm.patch, { cond_false_since: 10_000 });
  assertEquals(persistenceStep({ ...open, falseSince: 10_000, nowMs: 125_000 }).action, "none"); // 115s < 120s
  const resolve = persistenceStep({ ...open, falseSince: 10_000, nowMs: 130_000 });
  assertEquals(resolve.action, "resolve");
  assertEquals(resolve.patch, { cond_true_since: null, cond_false_since: null });
});

Deno.test("persistenceStep: condition returning true cancels a pending resolve", () => {
  const step = persistenceStep({ persistMs: 120_000, fired: true, hasOpen: true, trueSince: null, falseSince: 10_000, nowMs: 30_000 });
  assertEquals(step.action, "none");
  assertEquals(step.patch, { cond_false_since: null });
});

Deno.test("persistenceStep: open event + already-true condition writes nothing", () => {
  const step = persistenceStep({ persistMs: 120_000, fired: true, hasOpen: true, trueSince: null, falseSince: null, nowMs: 30_000 });
  assertEquals(step.action, "none");
  assertEquals(step.patch, {});
});

Deno.test("persistenceStep: clear with nothing open drops stale timers", () => {
  const step = persistenceStep({ persistMs: 120_000, fired: false, hasOpen: false, trueSince: 5_000, falseSince: null, nowMs: 99_000 });
  assertEquals(step.action, "none");
  assertEquals(step.patch, { cond_true_since: null, cond_false_since: null });
});
