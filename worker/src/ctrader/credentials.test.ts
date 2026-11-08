import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickCtraderAppCredentials } from './credentials'

describe('pickCtraderAppCredentials', () => {
  it('uses the trade worker environment when it is set', () => {
    assert.deepEqual(
      pickCtraderAppCredentials(
        { clientId: 'from-env', clientSecret: 'env-secret' },
        { clientId: 'stored', clientSecret: 'stored-secret' },
      ),
      { clientId: 'from-env', clientSecret: 'env-secret' },
    )
  })

  it('uses the credentials stored with the linked account', () => {
    assert.deepEqual(
      pickCtraderAppCredentials(
        { clientId: '', clientSecret: '' },
        { clientId: 'stored', clientSecret: 'stored-secret' },
      ),
      { clientId: 'stored', clientSecret: 'stored-secret' },
    )
  })

  it('requires both the app id and the secret', () => {
    assert.equal(
      pickCtraderAppCredentials(
        { clientId: '', clientSecret: '' },
        { clientId: 'stored', clientSecret: null },
      ),
      null,
    )
  })
})
