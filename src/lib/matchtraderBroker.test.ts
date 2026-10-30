import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_MATCHTRADER_DRAFT,
  normalizeMatchtraderServerUrl,
  parseMatchtraderDraft,
} from './matchtraderBroker'

describe('normalizeMatchtraderServerUrl', () => {
  it('keeps only the https host', () => {
    assert.equal(normalizeMatchtraderServerUrl('https://Trade.Broker.com/login?x=1'), null)
    assert.equal(normalizeMatchtraderServerUrl('https://Trade.Broker.com/path'), 'https://trade.broker.com')
    assert.equal(normalizeMatchtraderServerUrl('trade.broker.com'), 'https://trade.broker.com')
    assert.equal(normalizeMatchtraderServerUrl('  https://trade.broker.com:443  '), 'https://trade.broker.com')
  })

  it('rejects unsafe or malformed addresses', () => {
    for (const bad of [
      '',
      'http://trade.broker.com',
      'https://user:pw@trade.broker.com',
      'https://trade.broker.com:8443',
      'https://localhost',
      'https://127.0.0.1',
      'https://10.0.0.5',
      'https://[::1]',
      'ftp://trade.broker.com',
      'https://bad host.com',
      `https://${'a'.repeat(200)}.com`,
    ]) {
      assert.equal(normalizeMatchtraderServerUrl(bad), null, bad)
    }
  })
})

describe('parseMatchtraderDraft', () => {
  const draft = {
    ...DEFAULT_MATCHTRADER_DRAFT,
    serverUrl: ' https://trade.broker.com ',
    email: ' trader@example.com ',
    password: 'secret',
  }

  it('trims a valid draft and keeps the password as typed', () => {
    assert.deepEqual(parseMatchtraderDraft({ ...draft, accountId: ' #123456 ', brokerId: ' 42 ', label: ' Main ' }), {
      ok: true,
      login: {
        serverUrl: 'https://trade.broker.com',
        email: 'trader@example.com',
        password: 'secret',
        accountId: '123456',
        brokerId: '42',
        label: 'Main',
      },
    })
  })

  it('treats the account number and broker id as optional', () => {
    const parsed = parseMatchtraderDraft(draft)
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.login.accountId, '')
      assert.equal(parsed.login.brokerId, '')
    }
  })

  it('flags the first invalid field', () => {
    assert.deepEqual(parseMatchtraderDraft({ ...draft, serverUrl: '' }), { ok: false, field: 'serverUrl' })
    assert.deepEqual(parseMatchtraderDraft({ ...draft, serverUrl: 'http://trade.broker.com' }), { ok: false, field: 'serverUrl' })
    assert.deepEqual(parseMatchtraderDraft({ ...draft, email: 'not-an-email' }), { ok: false, field: 'email' })
    assert.deepEqual(parseMatchtraderDraft({ ...draft, password: '' }), { ok: false, field: 'password' })
    assert.deepEqual(parseMatchtraderDraft({ ...draft, accountId: 'bad id!' }), { ok: false, field: 'accountId' })
    assert.deepEqual(parseMatchtraderDraft({ ...draft, brokerId: 'bad id!' }), { ok: false, field: 'brokerId' })
  })
})
