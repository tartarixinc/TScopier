import assert from "node:assert/strict"
import test from "node:test"

import { normalizeTelegramPhoneNumber } from "./telegramPhone.ts"

test("normalizeTelegramPhoneNumber strips spaces, dashes and parentheses", () => {
  assert.equal(normalizeTelegramPhoneNumber("+44 7911 123-456"), "+447911123456")
  assert.equal(normalizeTelegramPhoneNumber("(020) 7946-0958"), "02079460958")
})

test("normalizeTelegramPhoneNumber converts leading 00 to +", () => {
  assert.equal(normalizeTelegramPhoneNumber("00447911123456"), "+44791123456")
  assert.equal(normalizeTelegramPhoneNumber("00 44 7911 123456"), "+447911123456")
})

test("normalizeTelegramPhoneNumber preserves an already-normalized number", () => {
  assert.equal(normalizeTelegramPhoneNumber("+447911123456"), "+447911123456")
})

test("normalizeTelegramPhoneNumber tolerates empty and nullish input", () => {
  assert.equal(normalizeTelegramPhoneNumber(""), "")
  assert.equal(normalizeTelegramPhoneNumber(undefined as unknown as string), "")
})
