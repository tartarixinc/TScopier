import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { applyCloseUpdate, type ClosePatch } from './tradeCloseUpdate'

type Response = { error: { code?: string; message?: string | null } | null }

function scripted(responses: Array<Response>) {
  const seen: Array<Record<string, unknown>> = []
  const run = async (patch: Record<string, unknown>): Promise<Response> => {
    seen.push(patch)
    const next = responses.shift()
    if (!next) throw new Error('scripted response list exhausted')
    return next
  }
  return { seen, run }
}

const patch = (): ClosePatch => ({
  status: 'closed',
  closed_at: '2026-10-06T00:00:00.000Z',
  close_reason: 'news_pre_close',
  metaapi_order_id: '400780254',
})

test('applies the update once when the column exists', async () => {
  const { seen, run } = scripted([{ error: null }])
  const res = await applyCloseUpdate(patch(), run)
  assert.equal(res.error, null)
  assert.equal(seen.length, 1)
  assert.ok('close_reason' in seen[0]!)
})

test('retries without close_reason when PostgREST cannot find the column', async () => {
  const { seen, run } = scripted([
    {
      error: {
        code: 'PGRST204',
        message: "Could not find the 'close_reason' column of 'trades' in the schema cache",
      },
    },
    { error: null },
  ])
  const res = await applyCloseUpdate(patch(), run)
  assert.equal(res.error, null)
  assert.equal(seen.length, 2)
  assert.ok('close_reason' in seen[0]!)
  assert.ok(!('close_reason' in seen[1]!), 'retry must drop close_reason')
  assert.equal(seen[1]!.status, 'closed', 'retry must keep the close itself')
  assert.equal(seen[1]!.closed_at, '2026-10-06T00:00:00.000Z')
  assert.equal(seen[1]!.metaapi_order_id, '400780254', 'retry must keep every other field')
})

test('a missing-column style error on a patch without close_reason is not retried', async () => {
  const { seen, run } = scripted([{ error: { code: 'PGRST204', message: 'other column' } }])
  const res = await applyCloseUpdate({ status: 'closed' }, run)
  assert.ok(res.error)
  assert.equal(seen.length, 1)
})

test('unrelated failures are returned untouched', async () => {
  const { seen, run } = scripted([
    { error: { code: '42501', message: 'permission denied for table trades' } },
  ])
  const res = await applyCloseUpdate(patch(), run)
  assert.equal(res.error?.code, '42501')
  assert.equal(seen.length, 1)
})

test('a failing retry returns the retry failure, not the original one', async () => {
  const { seen, run } = scripted([
    { error: { code: 'PGRST204', message: "Could not find the 'close_reason' column" } },
    { error: { code: '500', message: 'still broken' } },
  ])
  const res = await applyCloseUpdate(patch(), run)
  assert.equal(res.error?.message, 'still broken')
  assert.equal(seen.length, 2)
})
