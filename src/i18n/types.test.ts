import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  filterLocales,
  isLocale,
  LOCALES,
  normalizeLocaleSearchText,
} from '../i18n/types'

test('isLocale: accepts all supported locale codes', () => {
  for (const opt of LOCALES) {
    assert.equal(isLocale(opt.code), true)
  }
  assert.equal(isLocale('de'), false)
  assert.equal(isLocale(''), false)
  assert.equal(isLocale(null), false)
})

test('normalizeLocaleSearchText: strips diacritics and lowercases', () => {
  assert.equal(normalizeLocaleSearchText('Français'), 'francais')
  assert.equal(normalizeLocaleSearchText('  JA  '), 'ja')
})

test('filterLocales: empty query returns all locales', () => {
  assert.equal(filterLocales('').length, LOCALES.length)
  assert.equal(filterLocales('   ').length, LOCALES.length)
})

test('filterLocales: matches native name, English exonym, and code', () => {
  const japanese = filterLocales('jap')
  assert.equal(japanese.length, 1)
  assert.equal(japanese[0]?.code, 'ja')

  const polish = filterLocales('polski')
  assert.equal(polish.length, 1)
  assert.equal(polish[0]?.code, 'pl')

  const swedish = filterLocales('sweden')
  assert.equal(swedish.length, 1)
  assert.equal(swedish[0]?.code, 'sv')

  const russian = filterLocales('рус')
  assert.equal(russian.length, 1)
  assert.equal(russian[0]?.code, 'ru')
})

test('filterLocales: no match returns empty list', () => {
  assert.deepEqual(filterLocales('klingon'), [])
})
