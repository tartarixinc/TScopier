import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isTpBundleEnabled } from './tpBundleRollout'

test('unset flag denies', () => {
  assert.equal(isTpBundleEnabled({}), false)
})

test('empty/whitespace/invalid values deny', () => {
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: '' }), false)
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: '   ' }), false)
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: 'false' }), false)
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: '0' }), false)
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: 'off' }), false)
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: 'nope' }), false)
})

test('true/1/yes allow (case-insensitive)', () => {
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: 'true' }), true)
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: 'TRUE' }), true)
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: '1' }), true)
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: 'yes' }), true)
  assert.equal(isTpBundleEnabled({ TP_BUNDLE_ENABLED: ' true ' }), true)
})
