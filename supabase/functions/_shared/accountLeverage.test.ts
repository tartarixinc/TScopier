import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { accountLeveragePatch } from "./accountLeverage.ts"

Deno.test("accountLeveragePatch keeps sane broker leverage", () => {
  assertEquals(accountLeveragePatch(500), { account_leverage: 500 })
  assertEquals(accountLeveragePatch("100"), { account_leverage: 100 })
})

Deno.test("accountLeveragePatch ignores missing or invalid leverage", () => {
  assertEquals(accountLeveragePatch(undefined), {})
  assertEquals(accountLeveragePatch(null), {})
  assertEquals(accountLeveragePatch(0), {})
  assertEquals(accountLeveragePatch(NaN), {})
})
