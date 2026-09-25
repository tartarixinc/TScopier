import assert from "node:assert/strict"
import test from "node:test"
import { brokerIsAlreadyDisconnected, hasSubscriptionGraceElapsed } from "./subscriptionBrokerDisconnect.ts"
const now = new Date("2026-09-21T12:00:00.000Z")
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
test("subscription broker disconnect grace eligibility", () => {
  assert.equal(hasSubscriptionGraceElapsed({ status: "trialing", trial_ends_at: now.toISOString(), current_period_end: null }, now), false)
  assert.equal(hasSubscriptionGraceElapsed({ status: "canceled", trial_ends_at: null, current_period_end: daysAgo(29) }, now), false)
  assert.equal(hasSubscriptionGraceElapsed({ status: "canceled", trial_ends_at: null, current_period_end: daysAgo(30) }, now), true)
  assert.equal(hasSubscriptionGraceElapsed({ status: "past_due", trial_ends_at: null, current_period_end: daysAgo(31) }, now), true)
  assert.equal(hasSubscriptionGraceElapsed({ status: "active", trial_ends_at: null, current_period_end: daysAgo(90) }, now), false)
  assert.equal(hasSubscriptionGraceElapsed({ status: "trialing", trial_ends_at: daysAgo(31), current_period_end: null }, now), true)
})
test("already disconnected accounts need no duplicate remote action", () => {
  assert.equal(brokerIsAlreadyDisconnected({ fxsocket_status: "disconnected", connection_status: "connected" }), true)
  assert.equal(brokerIsAlreadyDisconnected({ fxsocket_status: "connected", connection_status: "disconnected" }), true)
  assert.equal(brokerIsAlreadyDisconnected({ fxsocket_status: "connected", connection_status: "connected" }), false)
})
