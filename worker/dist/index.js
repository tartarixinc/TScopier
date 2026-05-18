"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const supabase_js_1 = require("@supabase/supabase-js");
const ws_1 = __importDefault(require("ws"));
const sessionManager_1 = require("./sessionManager");
const authService_1 = require("./authService");
const httpServer_1 = require("./httpServer");
const tradeExecutor_1 = require("./tradeExecutor");
const virtualPendingMonitor_1 = require("./virtualPendingMonitor");
const cweCloseMonitor_1 = require("./cweCloseMonitor");
const partialTpMonitor_1 = require("./partialTpMonitor");
const signalEntryPendingMonitor_1 = require("./signalEntryPendingMonitor");
const autoManagementMonitor_1 = require("./autoManagementMonitor");
const trailingStopMonitor_1 = require("./trailingStopMonitor");
const basketSlTpReconcileMonitor_1 = require("./basketSlTpReconcileMonitor");
const newsTradingMonitor_1 = require("./newsTradingMonitor");
const brokerConnectionMonitor_1 = require("./brokerConnectionMonitor");
// Supabase Realtime needs a WebSocket transport in Node < 22.
// Railway is currently running Node 20, so we provide ws explicitly.
if (!globalThis.WebSocket) {
    globalThis.WebSocket = ws_1.default;
}
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sessionManager = new sessionManager_1.UserSessionManager(supabase);
const authService = new authService_1.AuthService(supabase, sessionManager);
const httpServer = (0, httpServer_1.startHttpServer)(authService, sessionManager);
const tradeExecutor = new tradeExecutor_1.TradeExecutor(supabase, sessionManager);
sessionManager.setTradeExecutor(tradeExecutor);
const virtualPendingMonitor = new virtualPendingMonitor_1.VirtualPendingMonitor(supabase);
const cweCloseMonitor = new cweCloseMonitor_1.CweCloseMonitor(supabase);
const partialTpMonitor = new partialTpMonitor_1.PartialTpMonitor(supabase);
const signalEntryPendingMonitor = new signalEntryPendingMonitor_1.SignalEntryPendingMonitor(supabase);
const trailingStopMonitor = new trailingStopMonitor_1.TrailingStopMonitor(supabase);
const autoManagementMonitor = new autoManagementMonitor_1.AutoManagementMonitor(supabase);
const basketSlTpReconcileMonitor = new basketSlTpReconcileMonitor_1.BasketSlTpReconcileMonitor(supabase);
const newsTradingMonitor = new newsTradingMonitor_1.NewsTradingMonitor(supabase);
const brokerConnectionMonitor = new brokerConnectionMonitor_1.BrokerConnectionMonitor(supabase);
async function main() {
    console.log('[worker] TSCopier Telegram worker starting...');
    await sessionManager.loadAll();
    await tradeExecutor.start();
    virtualPendingMonitor.start();
    cweCloseMonitor.start();
    partialTpMonitor.start();
    signalEntryPendingMonitor.start();
    trailingStopMonitor.start();
    autoManagementMonitor.start();
    basketSlTpReconcileMonitor.start();
    newsTradingMonitor.start();
    brokerConnectionMonitor.start();
    setInterval(async () => {
        await sessionManager.syncSessions();
    }, 30000);
    const shutdown = async (signal) => {
        console.log(`[worker] ${signal} received, shutting down...`);
        httpServer.close();
        authService.shutdown();
        tradeExecutor.stop();
        virtualPendingMonitor.stop();
        cweCloseMonitor.stop();
        partialTpMonitor.stop();
        signalEntryPendingMonitor.stop();
        trailingStopMonitor.stop();
        autoManagementMonitor.stop();
        basketSlTpReconcileMonitor.stop();
        newsTradingMonitor.stop();
        brokerConnectionMonitor.stop();
        await sessionManager.disconnectAll();
        // Let MTProto sockets finish closing so the next deploy does not overlap
        // the same auth key on Telegram (AUTH_KEY_DUPLICATED).
        await new Promise(r => setTimeout(r, Math.min(10000, Number(process.env.TELEGRAM_SHUTDOWN_DRAIN_MS ?? 1500))));
        process.exit(0);
    };
    process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
    process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}
main().catch(err => {
    console.error('[worker] Fatal error:', err);
    process.exit(1);
});
