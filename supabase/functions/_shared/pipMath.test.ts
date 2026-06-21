import { assertEquals } from 'jsr:@std/assert'
import { classifySymbol } from './pipMath.ts'

Deno.test('classifySymbol: FX major', () => {
  assertEquals(classifySymbol('EURUSD'), 'fx_major')
})

Deno.test('classifySymbol: JPY pair', () => {
  assertEquals(classifySymbol('USDJPY'), 'fx_jpy')
})

Deno.test('classifySymbol: metal', () => {
  assertEquals(classifySymbol('XAUUSD'), 'metal')
})

Deno.test('classifySymbol: crypto', () => {
  assertEquals(classifySymbol('BTCUSD'), 'crypto')
})

Deno.test('classifySymbol: index', () => {
  assertEquals(classifySymbol('US30'), 'index')
})
