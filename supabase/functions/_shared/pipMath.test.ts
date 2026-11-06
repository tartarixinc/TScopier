import { assertEquals } from "jsr:@std/assert"
import { classifySymbol } from "./pipMath.ts"

// Mirror-ordering regression (2026-11-01): CRYPTO_TOKENS (USDC/USDT) used to
// match before the 6-letter FX shape check, giving USDCAD/USDCHF/USDTRY the
// crypto classification and a 100× pip error. Keep in sync with
// worker/src/pipMath.test.ts and src/lib/pipMath.test.ts.

Deno.test("classifySymbol: FX shape wins over crypto tokens", () => {
  assertEquals(classifySymbol("USDCAD"), "fx_major")
  assertEquals(classifySymbol("USDCHF"), "fx_major")
  assertEquals(classifySymbol("USDTRY"), "fx_major")
  assertEquals(classifySymbol("USDCNH"), "fx_major")
})

Deno.test("classifySymbol: real crypto pairs stay crypto", () => {
  assertEquals(classifySymbol("BTCUSD"), "crypto")
  assertEquals(classifySymbol("ETHUSD"), "crypto")
  assertEquals(classifySymbol("BTCUSDT"), "crypto")
})
