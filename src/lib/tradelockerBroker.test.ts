import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_TRADELOCKER_DRAFT, parseTradelockerDraft } from './tradelockerBroker'

describe('parseTradelockerDraft', () => {
  const draft = {
    ...DEFAULT_TRADELOCKER_DRAFT,
    server: ' OSP-DEMO ',
    email: ' trader@example.com ',
    password: 'secret',
  }

  it('defaults to the demo environment', () => {
    assert.equal(DEFAULT_TRADELOCKER_DRAFT.environment, 'demo')
  })

  it('trims a valid draft and keeps the password as typed', () => {
    assert.deepEqual(parseTradelockerDraft({ ...draft, environment: 'live', accountId: ' #12345 ', label: ' Main ' }), {
      ok: true,
      login: {
        environment: 'live',
        server: 'OSP-DEMO',
        email: 'trader@example.com',
        password: 'secret',
        accountId: '12345',
        label: 'Main',
      },
    })
  })

  it('treats the account number as optional', () => {
    const parsed = parseTradelockerDraft(draft)
    assert.equal(parsed.ok, true)
    if (parsed.ok) assert.equal(parsed.login.accountId, '')
  })

  it('flags the first invalid field', () => {
    assert.deepEqual(parseTradelockerDraft({ ...draft, server: '   ' }), { ok: false, field: 'server' })
    assert.deepEqual(parseTradelockerDraft({ ...draft, server: 'bad\nserver' }), { ok: false, field: 'server' })
    assert.deepEqual(parseTradelockerDraft({ ...draft, server: 'x'.repeat(101) }), { ok: false, field: 'server' })
    assert.deepEqual(parseTradelockerDraft({ ...draft, email: 'not-an-email' }), { ok: false, field: 'email' })
    assert.deepEqual(parseTradelockerDraft({ ...draft, password: '' }), { ok: false, field: 'password' })
    assert.deepEqual(parseTradelockerDraft({ ...draft, accountId: 'abc' }), { ok: false, field: 'accountId' })
  })

  it('never lets an unknown environment through', () => {
    const parsed = parseTradelockerDraft({ ...draft, environment: 'staging' as 'demo' })
    assert.equal(parsed.ok && parsed.login.environment, 'demo')
  })
})
