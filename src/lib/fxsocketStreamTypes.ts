export type FxsocketStreamTopic = 'prices' | 'bars' | 'account' | 'positions' | 'trades' | 'terminal'

export interface FxsocketStreamSubscribeFrame {
  action: 'subscribe' | 'unsubscribe'
  topic: FxsocketStreamTopic
  symbol?: string
  timeframe?: string
  ticket?: number
}

export type FxsocketStreamMessage =
  | { type: 'tick'; symbol: string; data: Record<string, unknown> }
  | { type: 'bar'; symbol: string; timeframe: string; data: Record<string, unknown> }
  | { type: 'account'; data: Record<string, unknown> }
  | { type: 'positions'; data: unknown[] }
  | { type: 'trade'; data: Record<string, unknown> }
  | { type: 'terminal'; data: Record<string, unknown> }
  | { type: string; [key: string]: unknown }
