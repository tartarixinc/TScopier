import test from 'node:test'
import assert from 'node:assert/strict'
import { channelMatchesBrokerSignal } from '../brokerChannelFilter'
import { brokerHasLinkedSession } from './helpers'

const GTMO_CHANNEL = 'f4cf80de-8a3c-4cee-a736-e6dee343b1c8'
const FX_UUID = '6e5dc359-53c5-41b7-89bb-fc6dcd157208'

test('fxsocket-only broker passes dispatch session gate (Upcommers50K shape)', () => {
  const broker = {
    is_active: true,
    metaapi_account_id: '',
    fxsocket_account_id: FX_UUID,
    signal_channel_ids: [GTMO_CHANNEL],
    enforce_signal_channel_filter: true,
  }
  assert.equal(brokerHasLinkedSession(broker), true)
  assert.equal(channelMatchesBrokerSignal(broker, GTMO_CHANNEL), true)
})
