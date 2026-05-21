import assert from 'node:assert/strict'
import test from 'node:test'
import { parseQueueJobFields } from './signalQueuePublisher'

test('parseQueueJobFields round-trips payload', () => {
  const signal = {
    id: 'sig-abc',
    user_id: 'user-xyz',
    channel_id: 'ch-1',
    parsed_data: { action: 'buy' },
    status: 'parsed',
  }
  const fields = {
    signal_id: signal.id,
    user_id: signal.user_id,
    channel_id: signal.channel_id,
    action_class: 'buy',
    priority: 'high',
    shard_id: '2',
    lane: 'entry',
    idempotency_key: 'sig-abc:user-xyz:_:buy',
    attempts: '1',
    enqueued_at: String(Date.now()),
    pipeline_ts: JSON.stringify({ t_dispatch_sent: 100 }),
    payload: JSON.stringify(signal),
  }
  const job = parseQueueJobFields(fields)
  assert.ok(job)
  assert.equal(job!.signal_id, 'sig-abc')
  assert.equal(job!.lane, 'entry')
  assert.equal(job!.shard_id, 2)
  assert.equal(job!.signal.user_id, 'user-xyz')
  assert.equal(job!.pipeline_ts?.t_dispatch_sent, 100)
})

test('parseQueueJobFields returns null for malformed payload', () => {
  assert.equal(parseQueueJobFields({ payload: '{bad json' }), null)
})
