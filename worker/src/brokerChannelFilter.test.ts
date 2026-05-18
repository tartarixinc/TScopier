import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { channelMatchesBrokerSignal } from './brokerChannelFilter'

describe('channelMatchesBrokerSignal', () => {
  const chA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const chB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  it('allows any channel when no whitelist is configured', () => {
    assert.equal(channelMatchesBrokerSignal({}, chA), true)
    assert.equal(channelMatchesBrokerSignal({ enforce_signal_channel_filter: false }, chA), true)
  })

  it('restricts to listed channels when enforce is true', () => {
    const broker = { enforce_signal_channel_filter: true, signal_channel_ids: [chA] }
    assert.equal(channelMatchesBrokerSignal(broker, chA), true)
    assert.equal(channelMatchesBrokerSignal(broker, chB), false)
  })

  it('ignores signal_channel_ids when enforce is false (legacy rows)', () => {
    const broker = { enforce_signal_channel_filter: false, signal_channel_ids: [chA] }
    assert.equal(channelMatchesBrokerSignal(broker, chB), true)
  })

  it('allows all channels when enforce is on but list is empty (mis-save)', () => {
    assert.equal(channelMatchesBrokerSignal({ enforce_signal_channel_filter: true }, chA), true)
  })
})
