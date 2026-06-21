import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BrokerAccount } from '../types/database'
import {
  brokerLoginServerKey,
  canLinkAnotherBrokerInBatch,
  connectAccountsBatch,
  isDuplicateBrokerLogin,
  parseConnectAccountsCsv,
  parseCsvRows,
  resolveActiveBrokerCount,
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

  it('parseConnectAccountsCsv parses platform column', () => {
    const csv = `label,platform,broker_server,login,password
Live MT4,MT4,Broker-MT4,111,pass
Live MT5,MT5,Broker-MT5,222,pass`
    const { rows, errors } = parseConnectAccountsCsv(csv)
    assert.equal(errors.length, 0)
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.platform, 'MT4')
    assert.equal(rows[1]?.platform, 'MT5')
  })

  it('parseConnectAccountsCsv defaults platform to MT5 when column omitted', () => {
    const csv = `label,broker_server,login,password
Demo,Broker-Demo,111,pass`
    const { rows, errors } = parseConnectAccountsCsv(csv)
    assert.equal(errors.length, 0)
    assert.equal(rows[0]?.platform, 'MT5')
  })

  it('parseConnectAccountsCsv rejects invalid platform values', () => {
    const csv = `label,platform,broker_server,login,password
Bad,MT3,Broker,111,pass`
    const { rows, errors } = parseConnectAccountsCsv(csv)
    assert.equal(rows.length, 0)
    assert.equal(errors.length, 1)
    assert.match(errors[0]?.message ?? '', /Invalid platform/i)
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
      platform: 'MT5',
      broker_server: '',
      account_number: '1',
      account_password: 'x',
    }))
    assert.equal(validateConnectRow({
      label: '',
      platform: 'MT5',
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

  it('canLinkAnotherBrokerInBatch uses starting count plus linked rows only', () => {
    assert.equal(canLinkAnotherBrokerInBatch(4, 0, 5), true)
    assert.equal(canLinkAnotherBrokerInBatch(4, 1, 5), false)
    assert.equal(canLinkAnotherBrokerInBatch(0, 2, null), true)
  })

  it('connectAccountsBatch links sequentially and passes platform', async () => {
    const calls: Array<{ login?: string; platform?: string }> = []

    const result = await connectAccountsBatch({
      rows: [
        { label: 'A', platform: 'MT4', broker_server: 'S1', account_number: '1', account_password: 'p1' },
        { label: 'B', platform: 'MT5', broker_server: 'S2', account_number: '2', account_password: 'p2' },
      ],
      existingBrokers: [],
      activeBrokerCountAtStart: 4,
      maxBrokerAccounts: 5,
      onProgress: () => {},
      connect: async args => {
        calls.push({ login: String(args.login), platform: args.platform })
        return {
          account: broker({
            id: `id-${args.login}`,
            platform: args.platform ?? 'MT5',
            account_login: String(args.login),
            broker_server: String(args.server),
          }),
        }
      },
    })

    assert.deepEqual(calls, [{ login: '1', platform: 'MT4' }])
    assert.equal(result.linkedCount, 1)
    assert.equal(result.skippedCount, 1)
    assert.equal(result.rows[1]?.status, 'skipped_limit')
  })

  it('connectAccountsBatch recovers linked account after timeout', async () => {
    const result = await connectAccountsBatch({
      rows: [
        { label: '', platform: 'MT5', broker_server: 'S', account_number: '1', account_password: 'p' },
      ],
      existingBrokers: [],
      activeBrokerCountAtStart: 0,
      maxBrokerAccounts: 5,
      onProgress: () => {},
      connect: async () => {
        throw new Error('Broker request timed out. Try again in a moment.')
      },
      getKnownBrokers: () => [broker({
        id: 'recovered',
        account_login: '1',
        broker_server: 'S',
      })],
    })

    assert.equal(result.linkedCount, 1)
    assert.equal(result.rows[0]?.status, 'linked')
    assert.equal(result.rows[0]?.account?.id, 'recovered')
  })

  it('resolveActiveBrokerCount counts session-linked brokers regardless of copy toggle', () => {
    const sessionUuid = 'a1b2c3d4-e5f6-4789-a012-3456789abcde'
    const brokers = [
      broker({ id: 'a', fxsocket_account_id: sessionUuid, is_active: true }),
      broker({ id: 'b', fxsocket_account_id: sessionUuid, is_active: false }),
      broker({ id: 'c', is_active: true }),
    ]
    assert.equal(resolveActiveBrokerCount(brokers, 0), 2)
    assert.equal(resolveActiveBrokerCount(brokers, 4), 4)
  })

  it('connectAccountsBatch skips duplicates within batch and existing brokers', async () => {
    const result = await connectAccountsBatch({
      rows: [
        { label: '', platform: 'MT5', broker_server: 'S', account_number: '1', account_password: 'p' },
        { label: '', platform: 'MT5', broker_server: 'S', account_number: '1', account_password: 'p' },
      ],
      existingBrokers: [broker({ id: 'existing', account_login: '9', broker_server: 'Other' })],
      activeBrokerCountAtStart: 1,
      maxBrokerAccounts: 10,
      onProgress: () => {},
      connect: async () => ({
        account: broker({ id: 'new', account_login: '1', broker_server: 'S' }),
      }),
    })

    assert.equal(result.linkedCount, 1)
    assert.equal(result.rows[1]?.status, 'skipped_duplicate')
  })
})
