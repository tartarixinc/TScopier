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
const workerConfig_1 = require("./workerConfig");
if (!globalThis.WebSocket) {
    globalThis.WebSocket = ws_1.default;
}
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sessionManager = new sessionManager_1.UserSessionManager(supabase);
let httpServer = null;
let authService = null;
let tradeExecutor = null;
const monitors = [];
function startTradeMonitors() {
    if (workerConfig_1.workerConfig.runsExecutionMonitors) {
        const virtualPendingMonitor = new virtualPendingMonitor_1.VirtualPendingMonitor(supabase);
        const cweCloseMonitor = new cweCloseMonitor_1.CweCloseMonitor(supabase);
        const partialTpMonitor = new partialTpMonitor_1.PartialTpMonitor(supabase);
        const signalEntryPendingMonitor = new signalEntryPendingMonitor_1.SignalEntryPendingMonitor(supabase);
        virtualPendingMonitor.start();
        cweCloseMonitor.start();
        partialTpMonitor.start();
        signalEntryPendingMonitor.start();
        monitors.push(virtualPendingMonitor, cweCloseMonitor, partialTpMonitor, signalEntryPendingMonitor);
    }
    if (workerConfig_1.workerConfig.runsTrade) {
        const brokerConnectionMonitor = new brokerConnectionMonitor_1.BrokerConnectionMonitor(supabase);
        brokerConnectionMonitor.start();
        monitors.push(brokerConnectionMonitor);
    }
    if (workerConfig_1.workerConfig.runsManagementMonitors) {
        const trailingStopMonitor = new trailingStopMonitor_1.TrailingStopMonitor(supabase);
        const autoManagementMonitor = new autoManagementMonitor_1.AutoManagementMonitor(supabase);
        const basketSlTpReconcileMonitor = new basketSlTpReconcileMonitor_1.BasketSlTpReconcileMonitor(supabase);
        const newsTradingMonitor = new newsTradingMonitor_1.NewsTradingMonitor(supabase);
        trailingStopMonitor.start();
        autoManagementMonitor.start();
        basketSlTpReconcileMonitor.start();
        newsTradingMonitor.start();
        monitors.push(trailingStopMonitor, autoManagementMonitor, basketSlTpReconcileMonitor, newsTradingMonitor);
    }
}
async function main() {
    console.log(`[worker] starting role=${workerConfig_1.workerConfig.role} shard=${workerConfig_1.workerConfig.shardId}/${workerConfig_1.workerConfig.shardCount}`
        + ` instance=${workerConfig_1.workerConfig.instanceId}`);
    if (workerConfig_1.workerConfig.runsListener || workerConfig_1.workerConfig.runsBacktestHttp) {
        authService = new authService_1.AuthService(supabase, sessionManager);
        httpServer = (0, httpServer_1.startHttpServer)(authService, sessionManager);
    }
    if (workerConfig_1.workerConfig.runsTrade) {
        tradeExecutor = new tradeExecutor_1.TradeExecutor(supabase, sessionManager);
        sessionManager.setTradeExecutor(tradeExecutor);
        await tradeExecutor.start();
        startTradeMonitors();
        if (!httpServer) {
            httpServer = (0, httpServer_1.startTradeHttpServer)(sessionManager, tradeExecutor);
        }
    }
    else {
        sessionManager.setTradeExecutor(null);
    }
    if (workerConfig_1.workerConfig.runsListener) {
        await sessionManager.loadAll();
        setInterval(async () => {
            await sessionManager.syncSessions();
        }, 30000);
        if (workerConfig_1.workerConfig.role === 'listener' || workerConfig_1.workerConfig.role === 'all') {
            setInterval(async () => {
                await sessionManager.renewAllLeases();
            }, Math.max(10000, Number(process.env.WORKER_LEASE_RENEW_INTERVAL_MS ?? 20000)));
        }
    }
    else if (workerConfig_1.workerConfig.runsBacktestHttp) {
        console.log('[worker] backtest-only: no live Telegram listeners loaded');
    }
    const shutdown = async (signal) => {
        console.log(`[worker] ${signal} received, shutting down...`);
        httpServer?.close();
        authService?.shutdown();
        tradeExecutor?.stop();
        for (const m of monitors)
            m.stop();
        if (workerConfig_1.workerConfig.runsListener) {
            await sessionManager.disconnectAll();
        }
        await new Promise(r => setTimeout(r, Math.min(10000, Number(process.env.TELEGRAM_SHUTDOWN_DRAIN_MS ?? 8000))));
        process.exit(0);
    };
    process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
    process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}
main().catch(err => {
    console.error('[worker] Fatal error:', err);
    process.exit(1);
});
