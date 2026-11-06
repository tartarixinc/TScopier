import { describe, expect, it } from 'vitest'
import { classifySymbol } from './pipMath'

// Mirror-ordering regression (2026-11-01): CRYPTO_TOKENS (USDC/USDT) used to
// match before the 6-letter FX shape check, giving USDCAD/USDCHF/USDTRY the
// crypto classification and a 100× pip error. Keep in sync with
// worker/src/pipMath.test.ts and supabase/functions/_shared/pipMath.test.ts.
describe('classifySymbol: FX shape wins over crypto tokens', () => {
  it('keeps USDC/USDT-prefixed ISO pairs as forex', () => {
    expect(classifySymbol('USDCAD')).toBe('fx_major')
    expect(classifySymbol('USDCHF')).toBe('fx_major')
    expect(classifySymbol('USDTRY')).toBe('fx_major')
    expect(classifySymbol('USDCNH')).toBe('fx_major')
  })

  it('still classifies real crypto pairs as crypto', () => {
    expect(classifySymbol('BTCUSD')).toBe('crypto')
    expect(classifySymbol('ETHUSD')).toBe('crypto')
    expect(classifySymbol('BTCUSDT')).toBe('crypto')
  })
})
