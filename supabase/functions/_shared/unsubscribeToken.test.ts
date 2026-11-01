import { assert, assertEquals } from "jsr:@std/assert"
import {
  mintUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./unsubscribeToken.ts"

const KEY = "service-role-key-for-tests"
const UID = "af75b63e-7202-4b40-a7bf-2115535dcea1"

Deno.test("unsubscribeToken: mint produces stable 64-char hex", () => {
  const token = mintUnsubscribeToken(KEY, UID)
  assertEquals(token.length, 64)
  assertEquals(token, mintUnsubscribeToken(KEY, UID))
  assert(/^[0-9a-f]+$/.test(token))
})

Deno.test("unsubscribeToken: verify accepts a token minted with the same key", () => {
  const token = mintUnsubscribeToken(KEY, UID)
  assert(verifyUnsubscribeToken(KEY, UID, token))
})

Deno.test("unsubscribeToken: verify rejects a different key", () => {
  const token = mintUnsubscribeToken("another-key", UID)
  assertEquals(verifyUnsubscribeToken(KEY, UID, token), false)
})

Deno.test("unsubscribeToken: verify rejects a different user id", () => {
  const token = mintUnsubscribeToken(KEY, UID)
  assertEquals(
    verifyUnsubscribeToken(KEY, "00000000-0000-0000-0000-000000000000", token),
    false,
  )
})

Deno.test("unsubscribeToken: verify rejects truncated or padded tokens", () => {
  const token = mintUnsubscribeToken(KEY, UID)
  assertEquals(verifyUnsubscribeToken(KEY, UID, token.slice(0, -1)), false)
  assertEquals(verifyUnsubscribeToken(KEY, UID, token + "0"), false)
  assertEquals(verifyUnsubscribeToken(KEY, UID, ""), false)
})

Deno.test("unsubscribeToken: verify rejects non-hex garbage of the right length", () => {
  assertEquals(
    verifyUnsubscribeToken(KEY, UID, "z".repeat(64)),
    false,
  )
})
