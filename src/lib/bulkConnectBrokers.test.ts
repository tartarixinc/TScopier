import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BrokerAccount } from '../types/database'
import {
  brokerLoginServerKey,
  connectAccountsBatch,
  isDuplicateBrokerLogin,
  parseConnectAccountsCsv,
  parseCsvRows,
  validateConnectRow,
} from './bulkConnectBrokers'

function broker(overrides: Partial<BrokerAccount> & Pick<BrokerAccount, 'id'>): BrokerAccount {
  return {
    user_id: 'user-1',
    label: 'Test',
    platform: 'MT5',
    metaapi_account_id: '',
    is_active: true,
    default_lot_size: 0.01,
    pip_tolerance: 5,
    max_trades_per_zone: 3,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('bulkConnectBrokers', () => {
  it('parseCsvRows handles quoted commas', () => {
    const rows = parseCsvRows('label,server\n"Live, Main",ICMarketsSC-MT5\n')
    assert.equal(rows.length, 2)
    assert.equal(rows[1]?.[0], 'Live, Main')
  })

  it('parseConnectAccountsCsv parses template columns', () => {
    const csv = `label,broker_server,login,password
Live Main,ICMarketsSC-MT5,12345678,secret123
,ICMarketsSC-MT5,87654321,secret456`
    const { rows, errors } = parseConnectAccountsCsv(csv)
    assert.equal(errors.length, 0)
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.label, 'Live Main')
    assert.equal(rows[0]?.account_number, '12345678')
    assert.equal(rows[1]?.label, '')
  })

  it('parseConnectAccountsCsv accepts column aliases', () => {
    const csv = `account_label,server,mt_login,account_password
Demo,Broker-Demo,111,pass`
    const { rows, errors } = parseConnectAccountsCsv(csv)
    assert.equal(errors.length, 0)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.broker_server, 'Broker-Demo')
    assert.equal(rows[0]?.account_number, '111')
  })

  it('parseConnectAccountsCsv reports missing required columns', () => {
    const { rows, errors } = parseConnectAccountsCsv('label,login\nx,1\n')
    assert.equal(rows.length, 0)
    assert.equal(errors.length, 1)
  })

  it('validateConnectRow requires server, login, and password', () => {
    assert.ok(validateConnectRow({
      label: '',
      broker_server: '',
      account_number: '1',
      account_password: 'x',
    }))
    assert.equal(validateConnectRow({
      label: '',
      broker_server: 'S',
      account_number: '',
      account_password: 'x',
    }), 'MT login is required')
  })

  it('isDuplicateBrokerLogin matches login and server', () => {
    const existing = [broker({
      id: 'b1',
      account_login: '123',
      broker_server: 'ICMarketsSC-MT5',
    })]
    assert.equal(isDuplicateBrokerLogin('123', 'ICMarketsSC-MT5', existing), true)
    assert.equal(isDuplicateBrokerLogin('999', 'ICMarketsSC-MT5', existing), false)
    assert.equal(brokerLoginServerKey('123', 'ICMarketsSC-MT5'), '123::ICMarketsSC-MT5')
  })

  it('connectAccountsBatch links sequentially and stops at limit', async () => {
    const calls: string[] = []
    let allowed = 1

    const result = await connectAccountsBatch({
      rows: [
        { label: 'A', broker_server: 'S1', account_number: '1', account_password: 'p1' },
        { label: 'B', broker_server: 'S2', account_number: '2', account_password: 'p2' },
      ],
      existingBrokers: [],
      canAddMore: () => allowed > 0,
      onProgress: () => {},
      connect: async args => {
        calls.push(String(args.login))
        allowed--
        return {
          account: broker({
            id: `id-${args.login}`,
            account_login: String(args.login),
            broker_server: String(args.server),
          }),
        }
      },
    })

    assert.deepEqual(calls, ['1'])
    assert.equal(result.linkedCount, 1)
    assert.equal(result.skippedCount, 1)
    assert.equal(result.rows[1]?.status, 'skipped_limit')
  })

  it('connectAccountsBatch skips duplicates within batch and existing brokers', async () => {
    const result = await connectAccountsBatch({
      rows: [
        { label: '', broker_server: 'S', account_number: '1', account_password: 'p' },
        { label: '', broker_server: 'S', account_number: '1', account_password: 'p' },
      ],
      existingBrokers: [broker({ id: 'existing', account_login: '9', broker_server: 'Other' })],
      canAddMore: () => true,
      onProgress: () => {},
      connect: async () => ({
        account: broker({ id: 'new', account_login: '1', broker_server: 'S' }),
      }),
    })

    assert.equal(result.linkedCount, 1)
    assert.equal(result.rows[1]?.status, 'skipped_duplicate')
  })
})
