import assert from 'node:assert/strict'
import test from 'node:test'
import { prepSubstagePayload } from './pipelineTimestamps'

test('prepSubstagePayload omits zero-valued substages', () => {
  assert.deepEqual(
    prepSubstagePayload({
      prepPreHandleMs: 1200,
      prepInflightWaitMs: 0,
      prepGatesMs: 250,
      prepRevisionDbMs: 0,
      prepCopyLimitMs: 180,
      prepRevisionFlipMs: 0,
      prepChannelMetaMs: 95,
    }),
    {
      prep_pre_handle_ms: 1200,
      prep_gates_ms: 250,
      prep_copy_limit_ms: 180,
      prep_channel_meta_ms: 95,
    },
  )
})

test('prepSubstagePayload includes inflight and revision substages when present', () => {
  assert.deepEqual(
    prepSubstagePayload({
      prepPreHandleMs: 8500,
      prepInflightWaitMs: 8200,
      prepGatesMs: 120,
      prepRevisionDbMs: 340,
      prepCopyLimitMs: 0,
      prepRevisionFlipMs: 2100,
      prepChannelMetaMs: 0,
    }),
    {
      prep_pre_handle_ms: 8500,
      prep_inflight_wait_ms: 8200,
      prep_gates_ms: 120,
      prep_revision_db_ms: 340,
      prep_revision_flip_ms: 2100,
    },
  )
})
