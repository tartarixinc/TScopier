import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseTscopierComment, signalIdMatchesPrefix } from './tscopierComment'

describe('signalIdMatchesPrefix', () => {
  it('matches first 8 hex chars of a UUID', () => {
    const id = 'abc12345-6789-abcd-ef01-234567890abc'
    assert.equal(signalIdMatchesPrefix(id, 'abc12345'), true)
    assert.equal(signalIdMatchesPrefix(id, 'ABC12345'), true)
  })

  it('rejects non-matching or invalid prefixes', () => {
    const id = 'abc12345-6789-abcd-ef01-234567890abc'
    assert.equal(signalIdMatchesPrefix(id, 'deadbeef'), false)
    assert.equal(signalIdMatchesPrefix(id, 'abc'), false)
    assert.equal(signalIdMatchesPrefix(id, 'ghijklmn'), false)
  })
})

describe('parseTscopierComment', () => {
  it('extracts signal prefix from slugged comment', () => {
    const parsed = parseTscopierComment('TScopier:MyChannel:abc12345')
    assert.deepEqual(parsed, { channelSlug: 'MyChannel', signalIdPrefix: 'abc12345' })
  })

  it('extracts signal prefix from bare comment', () => {
    const parsed = parseTscopierComment('TScopier:abc12345')
    assert.deepEqual(parsed, { channelSlug: null, signalIdPrefix: 'abc12345' })
  })

  it('parses legacy TSCopier comment prefix', () => {
    const parsed = parseTscopierComment('TSCopier:MyChannel:abc12345')
    assert.deepEqual(parsed, { channelSlug: 'MyChannel', signalIdPrefix: 'abc12345' })
  })
})
