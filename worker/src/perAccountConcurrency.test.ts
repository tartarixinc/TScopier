import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createConcurrencyGate, runWithAccountLimit } from './perAccountConcurrency'

const tick = () => new Promise<void>(r => setTimeout(r, 5))

describe('createConcurrencyGate', () => {
  it('never exceeds the limit for a key and runs all tasks', async () => {
    const gate = createConcurrencyGate()
    let active = 0
    let peak = 0
    let done = 0
    const task = async () => {
      await runWithAccountLimit(gate, 'acct', 3, async () => {
        active += 1
        peak = Math.max(peak, active)
        await tick()
        active -= 1
        done += 1
      })
    }
    await Promise.all(Array.from({ length: 12 }, task))
    assert.equal(done, 12, 'all tasks ran')
    assert.ok(peak <= 3, `peak concurrency ${peak} must stay <= 3`)
    assert.equal(gate.activeCount('acct'), 0, 'all slots released')
  })

  it('isolates concurrency per key', async () => {
    const gate = createConcurrencyGate()
    const peak: Record<string, number> = { a: 0, b: 0 }
    const active: Record<string, number> = { a: 0, b: 0 }
    const task = (key: 'a' | 'b') => runWithAccountLimit(gate, key, 2, async () => {
      active[key] += 1
      peak[key] = Math.max(peak[key], active[key])
      await tick()
      active[key] -= 1
    })
    await Promise.all([
      ...Array.from({ length: 6 }, () => task('a')),
      ...Array.from({ length: 6 }, () => task('b')),
    ])
    assert.ok(peak.a <= 2 && peak.b <= 2)
  })

  it('releases the slot even when the task throws', async () => {
    const gate = createConcurrencyGate()
    await assert.rejects(
      runWithAccountLimit(gate, 'acct', 1, async () => { throw new Error('boom') }),
      /boom/,
    )
    assert.equal(gate.activeCount('acct'), 0)
    // A subsequent task can still acquire.
    let ran = false
    await runWithAccountLimit(gate, 'acct', 1, async () => { ran = true })
    assert.equal(ran, true)
  })

  it('serializes with limit 1 (FIFO progress)', async () => {
    const gate = createConcurrencyGate()
    const order: number[] = []
    let active = 0
    let peak = 0
    await Promise.all(Array.from({ length: 5 }, (_, i) => runWithAccountLimit(gate, 'k', 1, async () => {
      active += 1; peak = Math.max(peak, active)
      await tick()
      order.push(i)
      active -= 1
    })))
    assert.equal(peak, 1)
    assert.equal(order.length, 5)
  })
})
