import { describe, expect, it } from 'vitest'
import { normalizeFxsocketStreamMessage } from './fxsocketStreamNormalize'

describe('normalizeFxsocketStreamMessage', () => {
  it('maps bare FxSocket position rows to trade envelopes', () => {
    const msg = normalizeFxsocketStreamMessage({
      ticket: 1705377546,
      symbol: 'BTCUSD',
      type: 'Buy',
      kind: 'position',
      lots: 0.25,
      openPrice: 64281.47,
      currentPrice: 64250.02,
      stopLoss: 64110,
      takeProfit: 64500,
      swap: 0,
      profit: -7.86,
      magic: 909090,
      comment: 'TScopier:TestSignalCh:4a6c0a6b:',
      openTime: '2026-06-14T16:53:23.000Z',
    })
    expect(msg).toEqual({
      type: 'trade',
      data: expect.objectContaining({
        ticket: 1705377546,
        kind: 'position',
        profit: -7.86,
      }),
    })
  })

  it('passes through typed account envelopes', () => {
    const msg = normalizeFxsocketStreamMessage({
      type: 'account',
      data: { balance: 1000, equity: 1010, profit: 10 },
    })
    expect(msg).toEqual({
      type: 'account',
      data: { balance: 1000, equity: 1010, profit: 10 },
    })
  })

  it('maps bare account summaries without envelope', () => {
    const msg = normalizeFxsocketStreamMessage({
      balance: 1000,
      equity: 1010,
      profit: 10,
      currency: 'USD',
    })
    expect(msg).toEqual({
      type: 'account',
      data: expect.objectContaining({ balance: 1000, profit: 10 }),
    })
  })

  it('maps position arrays to positions envelopes', () => {
    const msg = normalizeFxsocketStreamMessage([
      { kind: 'position', type: 'Buy', ticket: 1, profit: 5, lots: 0.1, symbol: 'EURUSD' },
    ])
    expect(msg).toEqual({
      type: 'positions',
      data: [expect.objectContaining({ ticket: 1 })],
    })
  })
})
