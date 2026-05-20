import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { channelMatchesBrokerSignal } from './brokerChannelFilter'

describe('channelMatchesBrokerSignal', () => {
  const chA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const chB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  it('blocks all channels when whitelist is empty', () => {
    assert.equal(channelMatchesBrokerSignal({}, chA), false)
    assert.equal(channelMatchesBrokerSignal({ enforce_signal_channel_filter: false }, chA), false)
    assert.equal(channelMatchesBrokerSignal({ enforce_signal_channel_filter: true }, chA), false)
  })

  it('allows only listed channels', () => {
    const broker = { enforce_signal_channel_filter: true, signal_channel_ids: [chA] }
    assert.equal(channelMatchesBrokerSignal(broker, chA), true)
    assert.equal(channelMatchesBrokerSignal(broker, chB), false)
  })

  it('ignores enforce flag when ids are present (whitelist is authoritative)', () => {
    const broker = { enforce_signal_channel_filter: false, signal_channel_ids: [chA] }
    assert.equal(channelMatchesBrokerSignal(broker, chA), true)
    assert.equal(channelMatchesBrokerSignal(broker, chB), false)
  })
})
