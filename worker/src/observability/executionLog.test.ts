import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { writeExecutionLog, type ExecutionLogRow } from './executionLog'
import { getMetricsSnapshot, resetMetricsForTest } from '../workerMetrics'

type Captured = { table?: string; row?: unknown }

function fakeSupabase(result: { error?: { code?: string; message: string } | null } | Error, captured: Captured): SupabaseClient {
  const builder = {
    insert(row: unknown) {
      captured.row = row
      return Promise.resolve(result instanceof Error ? Promise.reject(result) : { error: result.error ?? null })
    },
  }
  return {
    from(table: string) {
      captured.table = table
      return builder
    },
  } as unknown as SupabaseClient
}

describe('writeExecutionLog', () => {
  const row: ExecutionLogRow = { action: 'unit_test', status: 'skipped', signal_id: 'sig-1' }
  const warns: string[] = []
  const originalWarn = console.warn

  beforeEach(() => {
    warns.length = 0
    resetMetricsForTest()
    console.warn = (msg?: unknown) => { warns.push(String(msg)) }
  })

  afterEach(() => {
    console.warn = originalWarn
  })

  it('inserts into trade_execution_logs and stays silent on success', async () => {
    const captured: Captured = {}
    await writeExecutionLog(fakeSupabase({ error: null }, captured), row)
    assert.equal(captured.table, 'trade_execution_logs')
    assert.deepEqual(captured.row, row)
    assert.equal(warns.length, 0)
    assert.equal(getMetricsSnapshot().execution_log_write_failed, undefined)
  })

  it('warns and counts when the database rejects the insert instead of dropping it', async () => {
    const captured: Captured = {}
    await writeExecutionLog(fakeSupabase({ error: { code: '23503', message: 'fk violation' } }, captured), row)
    assert.equal(warns.length, 1)
    assert.match(warns[0], /action=unit_test/)
    assert.match(warns[0], /23503/)
    assert.match(warns[0], /fk violation/)
    assert.equal(getMetricsSnapshot().execution_log_write_failed, 1)
  })

  it('warns and counts on a thrown transport error and never rethrows', async () => {
    const captured: Captured = {}
    await assert.doesNotReject(
      writeExecutionLog(fakeSupabase(new Error('socket hang up'), captured), row),
    )
    assert.equal(warns.length, 1)
    assert.match(warns[0], /socket hang up/)
    assert.equal(getMetricsSnapshot().execution_log_write_failed, 1)
  })
})
