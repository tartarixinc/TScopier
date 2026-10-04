// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBrokerReconnect } from './useBrokerReconnect'
import { fxsocketBroker } from '../lib/fxsocketBroker'
import type { BrokerAccount } from '../types/database'

// Tells React that act() may flush work in this process (React 18 requirement).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/fxsocketBroker', () => ({
  fxsocketBroker: {
    reconnect: vi.fn(async () => ({ account: { id: 'broker-1' } })),
    waitUntilConnected: vi.fn(async (id: string) => ({ account: { id } })),
  },
}))

const reconnectMock = vi.mocked(fxsocketBroker.reconnect)
const waitMock = vi.mocked(fxsocketBroker.waitUntilConnected)

let root: Root | null = null
let container: HTMLDivElement | null = null
let hookApi: ReturnType<typeof useBrokerReconnect> | null = null

function Harness({ brokers, onHook }: {
  brokers: BrokerAccount[]
  onHook: (hook: ReturnType<typeof useBrokerReconnect>) => void
}) {
  const hook = useBrokerReconnect({
    brokers,
    upsertBroker: () => {},
    reconnectFailedLabel: 'Reconnect failed',
  })
  useEffect(() => {
    onHook(hook)
  })
  return null
}

afterEach(() => {
  root?.unmount()
  container?.remove()
  root = null
  container = null
  hookApi = null
  reconnectMock.mockClear()
  waitMock.mockClear()
})

describe('useBrokerReconnect', () => {
  it('sends provider of the current broker list even when the list loads after mount', async () => {
    const mtapiBroker = {
      id: 'broker-1',
      provider: 'mtapi',
      mtapi_status: null,
    } as unknown as BrokerAccount

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    const capture = (hook: ReturnType<typeof useBrokerReconnect>) => {
      hookApi = hook
    }

    // Mount with the list still empty, as during page load.
    await act(async () => {
      root!.render(createElement(Harness, { brokers: [], onHook: capture }))
    })
    // The list arrives.
    await act(async () => {
      root!.render(createElement(Harness, { brokers: [mtapiBroker], onHook: capture }))
    })

    let done!: Promise<void>
    await act(async () => {
      done = hookApi!.reconnectBroker('broker-1')
    })
    await act(async () => {
      hookApi!.submitPasswordPrompt({ password: 'secret', rememberPassword: false })
      await done
    })

    expect(reconnectMock).toHaveBeenCalledWith({
      accountId: 'broker-1',
      password: 'secret',
      provider: 'mtapi',
    })
    expect(waitMock).toHaveBeenCalledWith(
      'broker-1',
      expect.objectContaining({ provider: 'mtapi' }),
    )
  })
})
