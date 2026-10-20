import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_DXTRADE_DRAFT,
  normalizeDxtradeServerUrl,
  parseDxtradeDraft,
} from './dxtradeBroker'

describe('normalizeDxtradeServerUrl', () => {
  it('turns a pasted platform link into the REST base', () => {
    for (const input of ['trade.broker.com', 'https://trade.broker.com/', 'https://TRADE.broker.com/dxsca-web/', 'https://trade.broker.com:443']) {
      assert.deepEqual(normalizeDxtradeServerUrl(input), { ok: true, url: 'https://trade.broker.com/dxsca-web' }, input)
    }
  })

  it('rejects addresses that could reach internal services', () => {
    for (const input of [
      '',
      'http://trade.broker.com',
      'https://user:pw@trade.broker.com',
      'https://trade.broker.com:8443',
      'https://trade.broker.com?x=1',
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://localhost',
      'https://intranet',
      'https://db.internal',
      'https://trade.broker.com/other',
    ]) {
      assert.equal(normalizeDxtradeServerUrl(input).ok, false, input)
    }
  })
})

describe('parseDxtradeDraft', () => {
  const draft = { ...DEFAULT_DXTRADE_DRAFT, serverUrl: 'trade.broker.com', username: ' trader ', password: 'secret' }

  it('normalizes a valid draft and defaults the domain', () => {
    assert.deepEqual(parseDxtradeDraft({ ...draft, domain: '  ', accountCode: ' default:1001 ', label: ' Main ' }), {
      ok: true,
      login: {
        serverUrl: 'https://trade.broker.com/dxsca-web',
        username: 'trader',
        domain: 'default',
        password: 'secret',
        accountCode: 'default:1001',
        label: 'Main',
      },
    })
  })

  it('reports the first invalid field', () => {
    assert.deepEqual(parseDxtradeDraft({ ...draft, serverUrl: 'http://x.com' }), { ok: false, field: 'server' })
    assert.deepEqual(parseDxtradeDraft({ ...draft, username: '' }), { ok: false, field: 'username' })
    assert.deepEqual(parseDxtradeDraft({ ...draft, username: 'trader@default' }), { ok: false, field: 'username' })
    assert.deepEqual(parseDxtradeDraft({ ...draft, password: '' }), { ok: false, field: 'password' })
  })
})
