"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribeMonitorWorkWake = subscribeMonitorWorkWake;
const WATCH_TABLES = [
    'range_pending_legs',
    'partial_tp_legs',
    'signal_entry_pending_orders',
    'basket_reconcile_jobs',
    'trades',
    'signals',
];
/**
 * Supabase Realtime wake: poke idle monitors when new work is inserted/updated.
 * Safety polling still runs on idle interval (Phase 3 hybrid).
 */
function subscribeMonitorWorkWake(supabase, loops) {
    const pokeAll = () => {
        for (const loop of loops)
            loop.poke();
    };
    const channel = supabase.channel(`monitor_work_wake:${process.pid}`);
    for (const table of WATCH_TABLES) {
        channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table }, pokeAll);
        channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table }, pokeAll);
    }
    channel.subscribe();
    return () => {
        void supabase.removeChannel(channel);
    };
}
