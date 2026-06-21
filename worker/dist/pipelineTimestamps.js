"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePipelineTimestamps = parsePipelineTimestamps;
exports.pipelineSummaryPayload = pipelineSummaryPayload;
function parsePipelineTimestamps(raw) {
    if (raw == null || typeof raw !== 'object')
        return undefined;
    const o = raw;
    const n = (k) => {
        const v = o[k];
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    };
    const ts = {
        t_ai_parse_done: n('t_ai_parse_done'),
        t_telegram_event: n('t_telegram_event'),
        t_listener_received: n('t_listener_received'),
        t_parse_done: n('t_parse_done'),
        t_dispatch_sent: n('t_dispatch_sent'),
        t_dispatch_received: n('t_dispatch_received'),
        t_order_send_start: n('t_order_send_start'),
        t_send_caches_resolved: n('t_send_caches_resolved'),
        t_session_resolved: n('t_session_resolved'),
        t_symbol_resolved: n('t_symbol_resolved'),
        t_params_resolved: n('t_params_resolved'),
        t_first_broker_send: n('t_first_broker_send'),
        t_last_broker_send: n('t_last_broker_send'),
        t_order_send_done: n('t_order_send_done'),
    };
    return Object.values(ts).some(v => v != null) ? ts : undefined;
}
function pipelineSummaryPayload(ts, extra) {
    const t0 = ts.t_telegram_event ?? ts.t_listener_received ?? ts.t_dispatch_received;
    const tEnd = ts.t_order_send_done ?? ts.t_dispatch_received ?? Date.now();
    const parseMs = ts.t_parse_done != null && ts.t_listener_received != null
        ? ts.t_parse_done - ts.t_listener_received
        : null;
    const dispatchMs = ts.t_dispatch_received != null && ts.t_dispatch_sent != null
        ? ts.t_dispatch_received - ts.t_dispatch_sent
        : null;
    const prepMs = ts.t_order_send_start != null && ts.t_dispatch_received != null
        ? ts.t_order_send_start - ts.t_dispatch_received
        : null;
    /** Full sendOrder (planning, channel delay, virtual persist, all legs). */
    const sendOrderMs = ts.t_order_send_done != null && ts.t_order_send_start != null
        ? ts.t_order_send_done - ts.t_order_send_start
        : null;
    /** Wall time across broker OrderSend API calls only. */
    const brokerSendMs = ts.t_last_broker_send != null && ts.t_first_broker_send != null
        ? ts.t_last_broker_send - ts.t_first_broker_send
        : null;
    /** Planning + quotes + virtual-pending setup inside sendOrder before first OrderSend. */
    const sendOrderPrepMs = ts.t_first_broker_send != null && ts.t_order_send_start != null
        ? ts.t_first_broker_send - ts.t_order_send_start
        : null;
    /** First half of send_order_prep: broker session/symbol/params cache resolution. */
    const brokerResolveMs = ts.t_send_caches_resolved != null && ts.t_order_send_start != null
        ? ts.t_send_caches_resolved - ts.t_order_send_start
        : null;
    /** Second half of send_order_prep: planning + merge routing + delay. */
    const sendPlanMs = ts.t_first_broker_send != null && ts.t_send_caches_resolved != null
        ? ts.t_first_broker_send - ts.t_send_caches_resolved
        : null;
    const sessionMs = ts.t_session_resolved != null && ts.t_order_send_start != null
        ? ts.t_session_resolved - ts.t_order_send_start
        : null;
    const symbolMs = ts.t_symbol_resolved != null && ts.t_order_send_start != null
        ? ts.t_symbol_resolved - ts.t_order_send_start
        : null;
    const paramsMs = ts.t_params_resolved != null && ts.t_order_send_start != null
        ? ts.t_params_resolved - ts.t_order_send_start
        : null;
    const totalMs = t0 != null ? tEnd - t0 : null;
    const telegramToListenerMs = ts.t_listener_received != null && ts.t_telegram_event != null
        ? ts.t_listener_received - ts.t_telegram_event
        : null;
    return {
        ...extra,
        telegram_to_listener_ms: telegramToListenerMs,
        parse_ms: parseMs,
        dispatch_ms: dispatchMs,
        prep_ms: prepMs,
        order_send_ms: sendOrderMs,
        send_order_ms: sendOrderMs,
        broker_send_ms: brokerSendMs,
        send_order_prep_ms: sendOrderPrepMs,
        broker_resolve_ms: brokerResolveMs,
        send_plan_ms: sendPlanMs,
        session_resolve_ms: sessionMs,
        symbol_resolve_ms: symbolMs,
        params_resolve_ms: paramsMs,
        total_ms: totalMs,
        timestamps: ts,
    };
}
