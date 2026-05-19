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
  t_order_send_start?: number
  t_order_send_done?: number
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
  const orderSendMs = ts.t_order_send_done != null && ts.t_order_send_start != null
    ? ts.t_order_send_done - ts.t_order_send_start
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
    order_send_ms: orderSendMs,
    total_ms: totalMs,
    timestamps: ts,
  }
}
