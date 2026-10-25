import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { DEFAULT_CHANNEL_KEYWORDS, parseChannelMessageSync } from './parseSignal'

/**
 * Signal format catalog — real production channel messages pinned as parse
 * expectations (built 2026-10-25, see scripts/signal-catalog.json).
 *
 * This is the breadth half of parser testing: parseSignal.tpLadder.test.ts
 * pins the shapes we have been burned by; this file pins the variety real
 * channels actually send (numbered/templated/bilingual/superscript entries,
 * management instructions, replies, ignored chatter) so a refactor cannot
 * quietly change how any of them parse. Cases flagged with a `note` pin
 * CURRENT behaviour that is a known issue — they must keep passing until the
 * issue itself is deliberately fixed (then the expectation moves with it).
 *
 * Assertions are asymmetric on purpose: only fields present in `expect` are
 * checked, so adding a field to a case pins it while untouched fields may
 * evolve without false failures.
 */

type CatalogCase = {
  id: string
  category: string
  message: string
  expect: {
    action: string
    symbol?: string
    sl?: number | null
    tp?: number[]
    entryPrice?: number
    tpUnit?: string
  }
  reply?: boolean
  useFor?: string[]
  note?: string
  prodNote?: string
}

const catalogPath = path.join(__dirname, '..', '..', 'scripts', 'signal-catalog.json')
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as {
  version: number
  categories: Record<string, string>
  cases: CatalogCase[]
}

test('catalog structure is sound', () => {
  assert.ok(Array.isArray(catalog.cases) && catalog.cases.length >= 50, 'catalog must carry a meaningful case count')
  assert.ok(Object.keys(catalog.categories).length >= 15, 'catalog must span many channel formats')
  const ids = new Set<string>()
  for (const c of catalog.cases) {
    assert.ok(c.message && c.message.trim().length > 0, `${c.id}: message must not be empty`)
    assert.ok(!ids.has(c.id), `${c.id}: duplicate case id`)
    ids.add(c.id)
    assert.ok(catalog.categories[c.category], `${c.id}: category ${c.category} not declared`)
    assert.ok(c.expect?.action, `${c.id}: missing expected action`)
    for (const use of c.useFor ?? ['regression']) {
      assert.ok(['regression', 'liveSend', 'fewshot'].includes(use), `${c.id}: bad useFor ${use}`)
    }
  }
  // The variety promise: this is not a catalogue of one repeated shape.
  const actions = new Set(catalog.cases.map(c => c.expect.action))
  assert.ok(actions.size >= 6, `expected many actions, got ${[...actions].join(',')}`)
  const withTp = catalog.cases.filter(c => (c.expect.tp ?? []).length >= 3).length
  assert.ok(withTp >= 15, `expected many multi-TP ladders, got ${withTp}`)
  const replies = catalog.cases.filter(c => c.reply).length
  assert.ok(replies >= 5, `expected reply-scoped cases, got ${replies}`)
})

for (const c of catalog.cases) {
  test(`catalog ${c.id}`, () => {
    const parsed = parseChannelMessageSync(c.message, DEFAULT_CHANNEL_KEYWORDS, null).parsed
    assert.equal(parsed.action, c.expect.action, `action mismatch${c.note ? ` (${c.note})` : ''}`)
    if (c.expect.symbol) assert.equal(parsed.symbol, c.expect.symbol, 'symbol mismatch')
    if (c.expect.sl !== undefined) assert.equal(parsed.sl, c.expect.sl, 'stop mismatch')
    if (c.expect.tp !== undefined) assert.deepEqual(parsed.tp, c.expect.tp, 'take-profit ladder mismatch')
    if (c.expect.entryPrice !== undefined) assert.equal(parsed.entry_price, c.expect.entryPrice, 'entry price mismatch')
    if (c.expect.tpUnit !== undefined) assert.equal(parsed.tp_unit, c.expect.tpUnit, 'price unit mismatch')
  })
}
