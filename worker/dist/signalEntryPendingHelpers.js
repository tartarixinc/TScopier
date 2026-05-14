"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rawOrderTicket = rawOrderTicket;
exports.rawOrderOperation = rawOrderOperation;
exports.isPendingEntryRow = isPendingEntryRow;
exports.findOpenedRowByTicket = findOpenedRowByTicket;
exports.findClosedRowForTicket = findClosedRowForTicket;
exports.cancelSignalEntryRowAtBroker = cancelSignalEntryRowAtBroker;
exports.markSignalEntryFilled = markSignalEntryFilled;
exports.markSignalEntryGoneFromBroker = markSignalEntryGoneFromBroker;
function rawOrderTicket(o) {
    const t = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? o.deal ?? o.Deal ?? 0);
    return Number.isFinite(t) ? t : 0;
}
function rawOrderOperation(o) {
    return String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '').toLowerCase();
}
/** True when /OpenedOrders row is a pending stop/limit entry (not a net position row). */
function isPendingEntryRow(o) {
    const op = rawOrderOperation(o);
    return op.includes('limit') || op.includes('stop');
}
function findOpenedRowByTicket(orders, ticket) {
    if (!Number.isFinite(ticket) || ticket <= 0)
        return null;
    for (const raw of orders ?? []) {
        if (!raw || typeof raw !== 'object')
            continue;
        const o = raw;
        if (rawOrderTicket(o) === ticket)
            return o;
    }
    return null;
}
/**
 * Best-effort fill lookup in /ClosedOrders for a pending ticket that disappeared
 * from /OpenedOrders (limit filled or cancelled).
 */
function findClosedRowForTicket(closed, ticket) {
    if (!Number.isFinite(ticket) || ticket <= 0)
        return null;
    for (const raw of closed ?? []) {
        if (!raw || typeof raw !== 'object')
            continue;
        const o = raw;
        if (rawOrderTicket(o) !== ticket)
            continue;
        const num = (v) => {
            if (typeof v === 'number' && Number.isFinite(v))
                return v;
            if (typeof v === 'string' && v.trim()) {
                const n = Number(v);
                return Number.isFinite(n) ? n : undefined;
            }
            return undefined;
        };
        return {
            openPrice: num(o.openPrice ?? o.OpenPrice ?? o.price ?? o.Price ?? o.priceOpen ?? o.PriceOpen),
            profit: num(o.profit ?? o.Profit),
            state: typeof o.state === 'string' ? o.state : typeof o.State === 'string' ? String(o.State) : undefined,
        };
    }
    return null;
}
/**
 * Delete broker pending via OrderClose (MT REST convention for removing pendings)
 * and mark DB rows terminal.
 */
async function cancelSignalEntryRowAtBroker(supabase, api, row, reason) {
    const uuid = row.metaapi_account_id;
    const ticket = Number(row.broker_ticket);
    if (!Number.isFinite(ticket) || ticket <= 0) {
        return { ok: false, error: 'invalid_ticket' };
    }
    try {
        await api.orderClose(uuid, { ticket });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
            .from('signal_entry_pending_orders')
            .update({
            status: 'cancel_failed',
            error_message: msg,
            cancel_reason: reason,
            updated_at: new Date().toISOString(),
        })
            .eq('id', row.id)
            .eq('status', 'broker_pending');
        return { ok: false, error: msg };
    }
    const now = new Date().toISOString();
    await supabase
        .from('signal_entry_pending_orders')
        .update({
        status: 'cancelled',
        cancel_reason: reason,
        updated_at: now,
    })
        .eq('id', row.id)
        .eq('status', 'broker_pending');
    if (row.trade_id) {
        await supabase
            .from('trades')
            .update({ status: 'cancelled', closed_at: now })
            .eq('id', row.trade_id)
            .eq('status', 'pending');
    }
    try {
        await supabase.from('trade_execution_logs').insert({
            user_id: row.user_id,
            signal_id: row.signal_id,
            broker_account_id: row.broker_account_id,
            action: 'signal_entry_pending_cancelled',
            status: 'success',
            request_payload: { row_id: row.id, ticket, reason },
        });
    }
    catch {
        /* best-effort */
    }
    return { ok: true };
}
async function markSignalEntryFilled(supabase, row, fillPrice, opts) {
    const now = new Date().toISOString();
    const px = Number.isFinite(fillPrice) && fillPrice > 0 ? fillPrice : row.entry_price;
    await supabase
        .from('signal_entry_pending_orders')
        .update({ status: 'filled', filled_at: now, updated_at: now })
        .eq('id', row.id)
        .eq('status', 'broker_pending');
    if (row.trade_id) {
        await supabase
            .from('trades')
            .update({ status: 'open', entry_price: px, opened_at: now })
            .eq('id', row.trade_id)
            .eq('status', 'pending');
    }
    const plan = opts?.partialTpPlan;
    if (plan && plan.length > 0 && row.trade_id) {
        const partialRows = plan.map(p => ({
            trade_id: row.trade_id,
            signal_id: row.signal_id,
            user_id: row.user_id,
            broker_account_id: row.broker_account_id,
            metaapi_account_id: row.metaapi_account_id,
            symbol: row.symbol,
            is_buy: row.is_buy,
            tp_idx: p.tpIdx,
            trigger_price: p.triggerPrice,
            close_lots: p.closeLots,
            status: 'pending',
        }));
        const { error: pErr } = await supabase.from('partial_tp_legs').insert(partialRows);
        if (pErr) {
            console.warn(`[signalEntryPendingHelpers] partial_tp_legs insert failed row=${row.id}: ${pErr.message}`);
        }
    }
    try {
        await supabase.from('trade_execution_logs').insert({
            user_id: row.user_id,
            signal_id: row.signal_id,
            broker_account_id: row.broker_account_id,
            action: 'signal_entry_pending_filled',
            status: 'success',
            request_payload: { row_id: row.id, ticket: row.broker_ticket, fill_price: px },
        });
    }
    catch {
        /* best-effort */
    }
}
async function markSignalEntryGoneFromBroker(supabase, row, note) {
    const now = new Date().toISOString();
    await supabase
        .from('signal_entry_pending_orders')
        .update({
        status: 'cancelled',
        cancel_reason: 'broker_missing',
        error_message: note,
        updated_at: now,
    })
        .eq('id', row.id)
        .eq('status', 'broker_pending');
    if (row.trade_id) {
        await supabase
            .from('trades')
            .update({ status: 'cancelled', closed_at: now })
            .eq('id', row.trade_id)
            .eq('status', 'pending');
    }
    try {
        await supabase.from('trade_execution_logs').insert({
            user_id: row.user_id,
            signal_id: row.signal_id,
            broker_account_id: row.broker_account_id,
            action: 'signal_entry_pending_sync',
            status: 'info',
            request_payload: { row_id: row.id, ticket: row.broker_ticket, note },
        });
    }
    catch {
        /* best-effort */
    }
}
