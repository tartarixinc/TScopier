/**
 * End-to-end latency stamps for live entry signals (Telegram → OrderSend).
 */
export type PipelineTimestamps = {
  /** Unix ms from Telegram message.date when available */
  t_telegram_event?: number
  t_listener_received?: number
  t_parse_done?: number
  t_dispatch_sent?: number
  t_dispatch_received?: number
  /** Trade worker began sendOrder (planning + delay + virtual persist). */
  t_order_send_start?: number
  /** First broker OrderSend call for this signal. */
  t_first_broker_send?: number
  /** Last broker OrderSend call returned for this signal. */
  t_last_broker_send?: number
  t_order_send_done?: number
}

export function parsePipelineTimestamps(raw: unknown): PipelineTimestamps | undefined {
  if (raw == null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const n = (k: string) => {
    const v = o[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const ts: PipelineTimestamps = {
    t_telegram_event: n('t_telegram_event'),
    t_listener_received: n('t_listener_received'),
    t_parse_done: n('t_parse_done'),
    t_dispatch_sent: n('t_dispatch_sent'),
    t_dispatch_received: n('t_dispatch_received'),
    t_order_send_start: n('t_order_send_start'),
    t_first_broker_send: n('t_first_broker_send'),
    t_last_broker_send: n('t_last_broker_send'),
    t_order_send_done: n('t_order_send_done'),
  }
  return Object.values(ts).some(v => v != null) ? ts : undefined
}

export function pipelineSummaryPayload(
  ts: PipelineTimestamps,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const t0 = ts.t_telegram_event ?? ts.t_listener_received ?? ts.t_dispatch_received
  const tEnd = ts.t_order_send_done ?? ts.t_dispatch_received ?? Date.now()
  const parseMs = ts.t_parse_done != null && ts.t_listener_received != null
    ? ts.t_parse_done - ts.t_listener_received
    : null
  const dispatchMs = ts.t_dispatch_received != null && ts.t_dispatch_sent != null
    ? ts.t_dispatch_received - ts.t_dispatch_sent
    : null
  const prepMs = ts.t_order_send_start != null && ts.t_dispatch_received != null
    ? ts.t_order_send_start - ts.t_dispatch_received
    : null
  /** Full sendOrder (planning, channel delay, virtual persist, all legs). */
  const sendOrderMs = ts.t_order_send_done != null && ts.t_order_send_start != null
    ? ts.t_order_send_done - ts.t_order_send_start
    : null
  /** Wall time across broker OrderSend API calls only. */
  const brokerSendMs = ts.t_last_broker_send != null && ts.t_first_broker_send != null
    ? ts.t_last_broker_send - ts.t_first_broker_send
    : null
  const totalMs = t0 != null ? tEnd - t0 : null
  const telegramToListenerMs = ts.t_listener_received != null && ts.t_telegram_event != null
    ? ts.t_listener_received - ts.t_telegram_event
    : null
  return {
    ...extra,
    telegram_to_listener_ms: telegramToListenerMs,
    parse_ms: parseMs,
    dispatch_ms: dispatchMs,
    prep_ms: prepMs,
    order_send_ms: sendOrderMs,
    send_order_ms: sendOrderMs,
    broker_send_ms: brokerSendMs,
    total_ms: totalMs,
    timestamps: ts,
  }
}
