import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchTradesAcrossProviders, fxsocketBroker, type MtTrade } from './fxsocketBroker'
import { getLiveFeedStatus, reportLiveFeedSuccess, resetLiveFeedStatus } from './liveFeedStatus'

function trade(ticket: number, brokerId: string): MtTrade {
  return {
    id: `${brokerId}:${ticket}`,
    broker_id: brokerId,
    broker_label: 'Demo',
    broker_name: null,
    ticket,
    symbol: 'XAUUSD',
    direction: 'buy',
    type: 'Buy',
    lot_size: 0.01,
    entry_price: 100,
    sl: null,
    tp: null,
    close_price: null,
    profit: null,
    swap: null,
    commission: null,
    comment: null,
    magic: null,
    opened_at: '2026-09-23T08:00:00.000Z',
    closed_at: null,
    state: null,
    status: 'open',
  }
}

describe('fetchTradesAcrossProviders', () => {
  let tradesSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tradesSpy = vi.spyOn(fxsocketBroker, 'trades')
  })

  afterEach(() => {
    tradesSpy.mockRestore()
  })

  it('queries both providers when accounts lack an explicit provider field', async () => {
    tradesSpy.mockResolvedValue({ trades: [] })
    await fetchTradesAcrossProviders({ accounts: [{}, {}] })
    expect(tradesSpy).toHaveBeenCalledTimes(2)
  })

  it('returns empty when only explicit providers are requested and both succeed', async () => {
    tradesSpy.mockResolvedValue({ trades: [] })
    const res = await fetchTradesAcrossProviders({
      accounts: [{ provider: 'fxsocket' }],
    })
    expect(res.trades).toEqual([])
    expect(tradesSpy).toHaveBeenCalledTimes(1)
    expect(tradesSpy.mock.calls[0]?.[0]?.provider).toBe('fxsocket')
  })

  it('calls a single edge when only one provider is present', async () => {
    tradesSpy.mockResolvedValue({ trades: [trade(1, 'b1')] })
    const res = await fetchTradesAcrossProviders({
      accounts: [{ provider: 'mtapi' }],
      scope: 'open',
    })
    expect(res.trades).toHaveLength(1)
    expect(tradesSpy).toHaveBeenCalledTimes(1)
    expect(tradesSpy.mock.calls[0]?.[0]?.provider).toBe('mtapi')
  })

  it('merges results when both providers return data', async () => {
    tradesSpy.mockImplementation(async (args) => ({
      trades: args.provider === 'mtapi'
        ? [trade(2, 'mtapi-b')]
        : [trade(1, 'fx-b')],
    }))
    const res = await fetchTradesAcrossProviders({ scope: 'all' })
    expect(res.trades.map(t => t.ticket).sort()).toEqual([1, 2])
    expect(tradesSpy).toHaveBeenCalledTimes(2)
  })

  it('ignores a wrong-provider rejection when the other provider has data', async () => {
    tradesSpy.mockImplementation(async (args) => {
      if (args.provider === 'fxsocket') {
        return { trades: [trade(9, 'fx-b')] }
      }
      throw new Error('This account is not an MTAPI account.')
    })
    const res = await fetchTradesAcrossProviders({ brokerId: 'fx-b' })
    expect(res.trades).toHaveLength(1)
    expect(res.trades[0]?.ticket).toBe(9)
  })

  it('throws when every provider fails', async () => {
    tradesSpy.mockRejectedValue(new Error('edge down'))
    await expect(fetchTradesAcrossProviders({})).rejects.toThrow('edge down')
  })

  it('throws when all fulfilled providers are empty and another failed for a real reason', async () => {
    tradesSpy.mockImplementation(async (args) => {
      if (args.provider === 'fxsocket') return { trades: [] }
      throw new Error('MTAPI is not configured')
    })
    await expect(fetchTradesAcrossProviders({})).rejects.toThrow('MTAPI is not configured')
  })

  it('raises the degraded feed banner when one provider succeeds and another really fails', async () => {
    resetLiveFeedStatus()
    tradesSpy.mockImplementation(async (args) => {
      if (args.provider === 'fxsocket') return { trades: [trade(1, 'b1')] }
      throw new Error('mtapi edge down')
    })
    const res = await fetchTradesAcrossProviders({})
    expect(res.trades).toHaveLength(1)
    expect(getLiveFeedStatus().degraded).toBe(true)
    expect(getLiveFeedStatus().reason).toContain('mtapi edge down')
    reportLiveFeedSuccess()
  })

  it('does not raise the banner for a wrong-provider rejection', async () => {
    resetLiveFeedStatus()
    tradesSpy.mockImplementation(async (args) => {
      if (args.provider === 'fxsocket') return { trades: [trade(9, 'fx-b')] }
      throw new Error('This account is not an MTAPI account.')
    })
    await fetchTradesAcrossProviders({ brokerId: 'fx-b' })
    expect(getLiveFeedStatus().degraded).toBe(false)
  })
})

describe('fxsocketBroker.trades ?demo=broker-down', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects before any network call when the flag is set', async () => {
    vi.stubGlobal('window', { location: { search: '?demo=broker-down' } })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(fxsocketBroker.trades({ scope: 'all' })).rejects.toThrow(
      'Broker feed is down (demo flag)',
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not engage the guard without the flag', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    // Stub the network: whatever stage the call reaches (the auth check
    // before fetch, or fetch itself), no real request can leave the test.
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network off in tests')))
    vi.stubGlobal('fetch', fetchSpy)

    const err = await fxsocketBroker.trades({ scope: 'all' }).then(
      () => null,
      (e: unknown) => e as Error,
    )
    // Without the flag the call proceeds past the guard into the real
    // auth/network path — it must fail there, not with the demo message.
    expect(err?.message).not.toBe('Broker feed is down (demo flag)')
    expect(['Not signed in', 'network off in tests']).toContain(err?.message)
  })
})
