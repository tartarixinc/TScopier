import { CTRADER_PAYLOAD, ctraderErrorMessage } from './protocol'

export interface CtraderSocket {
  send(data: string): void
  close(): void
  onMessage(handler: (data: string) => void): void
  onClose(handler: () => void): void
}

export interface CtraderEnvelope {
  clientMsgId?: string
  payloadType: number
  payload?: Record<string, unknown>
}

type Waiter = {
  types: number[]
  resolve: (payload: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** JSON Open API session. The socket is injected so tests never dial Spotware. */
export class CtraderSession {
  private readonly pending = new Map<string, Waiter>()
  private seq = 0
  private closed = false

  constructor(private readonly socket: CtraderSocket) {
    socket.onMessage(raw => this.handle(raw))
    socket.onClose(() => this.failAll(new Error('cTrader connection closed')))
  }

  close(): void {
    this.closed = true
    this.failAll(new Error('cTrader connection closed'))
    this.socket.close()
  }

  request(
    payloadType: number,
    payload: Record<string, unknown>,
    responseTypes: number[],
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('cTrader connection closed'))
    const clientMsgId = String(++this.seq)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId)
        reject(new Error('cTrader request timed out'))
      }, timeoutMs)
      this.pending.set(clientMsgId, { types: responseTypes, resolve, reject, timer })
      this.socket.send(JSON.stringify({ clientMsgId, payloadType, payload }))
    })
  }

  private handle(raw: string): void {
    let msg: CtraderEnvelope
    try {
      msg = JSON.parse(raw) as CtraderEnvelope
    } catch {
      return
    }
    const payloadType = Number(msg.payloadType)
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {}
    const clientMsgId = String(msg.clientMsgId ?? payload.clientMsgId ?? '')
    const failure = payloadType === CTRADER_PAYLOAD.ERROR_RES
      || payloadType === CTRADER_PAYLOAD.ORDER_ERROR_EVENT
    if (failure) {
      const waiter = this.take(clientMsgId, null)
      waiter?.reject(new Error(ctraderErrorMessage(payload)))
      return
    }
    const waiter = this.take(clientMsgId, payloadType)
    waiter?.resolve(payload)
  }

  private take(clientMsgId: string, payloadType: number | null): Waiter | undefined {
    if (clientMsgId && this.pending.has(clientMsgId)) {
      const waiter = this.pending.get(clientMsgId)
      this.pending.delete(clientMsgId)
      if (waiter) clearTimeout(waiter.timer)
      return waiter
    }
    for (const [id, waiter] of this.pending) {
      if (payloadType == null || waiter.types.includes(payloadType)) {
        this.pending.delete(id)
        clearTimeout(waiter.timer)
        return waiter
      }
    }
    return undefined
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}

export function openCtraderWebSocket(url: string): Promise<CtraderSocket> {
  return new Promise((resolve, reject) => {
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!WS) {
      reject(new Error('WebSocket is not available in this worker runtime'))
      return
    }
    const ws = new WS(url)
    let onMessage: ((data: string) => void) | null = null
    let onClose: (() => void) | null = null
    let settled = false
    const socket: CtraderSocket = {
      send(data) { ws.send(data) },
      close() { ws.close() },
      onMessage(handler) { onMessage = handler },
      onClose(handler) { onClose = handler },
    }
    ws.addEventListener('open', () => {
      if (settled) return
      settled = true
      resolve(socket)
    })
    ws.addEventListener('message', event => {
      const data = typeof event.data === 'string' ? event.data : ''
      if (data) onMessage?.(data)
    })
    ws.addEventListener('close', () => onClose?.())
    ws.addEventListener('error', () => {
      if (settled) return
      settled = true
      reject(new Error('cTrader connection failed'))
    })
  })
}
