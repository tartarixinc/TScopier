import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { unwrapOrderList } from './metatraderapi'

describe('unwrapOrderList', () => {
  it('returns bare arrays unchanged', () => {
    const rows = [{ ticket: 1 }]
    assert.deepEqual(unwrapOrderList(rows), rows)
  })

  it('unwraps top-level orders/Orders keys', () => {
    const rows = [{ ticket: 2 }]
    assert.deepEqual(unwrapOrderList({ orders: rows }), rows)
    assert.deepEqual(unwrapOrderList({ Orders: rows }), rows)
  })

  it('unwraps nested result.Orders (OpenedOrders / ClosedOrders shape)', () => {
    const rows = [{ ticket: 3 }]
    assert.deepEqual(unwrapOrderList({ result: { Orders: rows } }), rows)
    assert.deepEqual(unwrapOrderList({ Result: { orders: rows } }), rows)
  })

  it('returns empty array for non-list payloads', () => {
    assert.deepEqual(unwrapOrderList(null), [])
    assert.deepEqual(unwrapOrderList({ result: { PagesCount: 1 } }), [])
  })
})
