import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mirrorCopyAccountModeSupported } from './mirrorCopyAccountMode'

test('mirror copy runs only on confirmed hedging accounts', () => {
  assert.equal(mirrorCopyAccountModeSupported('hedging'), true)
  assert.equal(mirrorCopyAccountModeSupported('HEDGING'), true)
  assert.equal(mirrorCopyAccountModeSupported('netting'), false)
  assert.equal(mirrorCopyAccountModeSupported('unknown'), false)
  assert.equal(mirrorCopyAccountModeSupported(null), false)
  assert.equal(mirrorCopyAccountModeSupported(undefined), false)
})
