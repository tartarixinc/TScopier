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
const signalRangeEntryMonitor_1 = require("./signalRangeEntryMonitor");
const autoManagementMonitor_1 = require("./autoManagementMonitor");
const trailingStopMonitor_1 = require("./trailingStopMonitor");
const basketSlTpReconcileMonitor_1 = require("./basketSlTpReconcileMonitor");
const newsTradingMonitor_1 = require("./newsTradingMonitor");
const v2ReconcileMonitor_1 = require("./engine/v2ReconcileMonitor");
const executionMode_1 = require("./engine/executionMode");
const openTradeReconcileMonitor_1 = require("./openTradeReconcileMonitor");
const brokerStreamProxy_1 = require("./brokerStreamProxy");
const fxsocketStreamManager_1 = require("./fxsocketStreamManager");
const copyLimitMonitor_1 = require("./copyLimitMonitor");
const workerConfig_1 = require("./workerConfig");
const tradeSignalPush_1 = require("./tradeSignalPush");
const signalQueueConsumer_1 = require("./queue/signalQueueConsumer");
const signalQueueConfig_1 = require("./queue/signalQueueConfig");
const queueHealth_1 = require("./queue/queueHealth");
const monitorWorkWake_1 = require("./monitorWorkWake");
const tradeLogRetention_1 = require("./tradeLogRetention");
if (!globalThis.WebSocket) {
    globalThis.WebSocket = ws_1.default;
}
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sessionManager = new sessionManager_1.UserSessionManager(supabase);
let httpServer = null;
let authService = null;
let tradeExecutor = null;
let signalQueueConsumers = null;
const monitors = [];
const monitorLoops = [];
let stopLogRetention = null;
let stopWorkWake = null;
function trackMonitor(m) {
    monitors.push(m);
    if (m.getLoopHandle) {
        const h = m.getLoopHandle();
        if (h)
            monitorLoops.push(h);
    }
    if (m.getLoopHandles) {
        monitorLoops.push(...m.getLoopHandles());
    }
}
function startTradeMonitors(executor) {
    if (workerConfig_1.workerConfig.runsExecutionMonitors) {
        const virtualPendingMonitor = new virtualPendingMonitor_1.VirtualPendingMonitor(supabase);
        const cweCloseMonitor = new cweCloseMonitor_1.CweCloseMonitor(supabase);
        const partialTpMonitor = new partialTpMonitor_1.PartialTpMonitor(supabase);
        const signalEntryPendingMonitor = new signalEntryPendingMonitor_1.SignalEntryPendingMonitor(supabase);
        const openTradeReconcileMonitor = new openTradeReconcileMonitor_1.OpenTradeReconcileMonitor(supabase);
        virtualPendingMonitor.start();
        cweCloseMonitor.start();
        partialTpMonitor.start();
        signalEntryPendingMonitor.start();
        openTradeReconcileMonitor.start();
        trackMonitor(virtualPendingMonitor);
        trackMonitor(cweCloseMonitor);
        trackMonitor(partialTpMonitor);
        trackMonitor(signalEntryPendingMonitor);
        trackMonitor(openTradeReconcileMonitor);
        if (executor) {
            const signalRangeEntryMonitor = new signalRangeEntryMonitor_1.SignalRangeEntryMonitor(supabase, executor);
            signalRangeEntryMonitor.start();
            trackMonitor(signalRangeEntryMonitor);
        }
    }
    if (workerConfig_1.workerConfig.runsTrade) {
        const copyLimitMonitor = new copyLimitMonitor_1.CopyLimitMonitor(supabase);
        copyLimitMonitor.start();
        trackMonitor(copyLimitMonitor);
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
        trackMonitor(trailingStopMonitor);
        trackMonitor(autoManagementMonitor);
        trackMonitor(basketSlTpReconcileMonitor);
        trackMonitor(newsTradingMonitor);
        // Management-first v2 cutover: a single reconcile loop owns background
        // convergence for v2-flagged brokers (the v1 job reconciler skips them).
        if ((0, executionMode_1.v2EngineConfigured)()) {
            const v2ReconcileMonitor = new v2ReconcileMonitor_1.V2ReconcileMonitor(supabase);
            v2ReconcileMonitor.start();
            trackMonitor(v2ReconcileMonitor);
        }
    }
    stopLogRetention = (0, tradeLogRetention_1.startTradeLogRetention)(supabase);
}
async function main() {
    if (workerConfig_1.workerConfig.runsListener) {
        const shardErr = (0, tradeSignalPush_1.validateListenerTradeShardConfig)();
        if (shardErr) {
            console.error(`[worker] FATAL: ${shardErr}`);
            process.exit(1);
        }
        const mgmtShardErr = (0, tradeSignalPush_1.validateListenerMgmtShardConfig)();
        if (mgmtShardErr) {
            console.error(`[worker] FATAL: ${mgmtShardErr}`);
            process.exit(1);
        }
        const queueErr = (0, tradeSignalPush_1.validateListenerQueueConfig)();
        if (queueErr) {
            console.error(`[worker] FATAL: ${queueErr}`);
            process.exit(1);
        }
    }
    console.log(`[worker] starting role=${workerConfig_1.workerConfig.role} shard=${workerConfig_1.workerConfig.shardId}/${workerConfig_1.workerConfig.shardCount}`
        + ` instance=${workerConfig_1.workerConfig.instanceId} build=${workerConfig_1.WORKER_BUILD_TAG}`);
    if (workerConfig_1.workerConfig.runsListener || workerConfig_1.workerConfig.runsBacktestHttp) {
        authService = new authService_1.AuthService(supabase, sessionManager);
        httpServer = (0, httpServer_1.startHttpServer)(authService, sessionManager);
    }
    if (workerConfig_1.workerConfig.runsTrade) {
        tradeExecutor = new tradeExecutor_1.TradeExecutor(supabase, sessionManager);
        sessionManager.setTradeExecutor(tradeExecutor);
        await tradeExecutor.start();
        const sweepHandle = tradeExecutor.getSweepLoopHandle();
        if (sweepHandle)
            monitorLoops.push(sweepHandle);
        startTradeMonitors(tradeExecutor);
        if (monitorLoops.length > 0 && !stopWorkWake) {
            stopWorkWake = (0, monitorWorkWake_1.subscribeMonitorWorkWake)(supabase, monitorLoops);
        }
        if (!httpServer) {
            httpServer = (0, httpServer_1.startTradeHttpServer)(sessionManager, tradeExecutor);
        }
        if (httpServer) {
            const streamManager = (0, fxsocketStreamManager_1.getFxsocketStreamManager)();
            if (streamManager) {
                (0, brokerStreamProxy_1.attachBrokerStreamProxy)(httpServer, supabase, streamManager);
                console.log('[worker] broker stream proxy attached at /broker/stream');
            }
            else {
                console.error('[worker] broker stream proxy DISABLED — set FXSOCKET_API_KEY on this trade worker'
                    + ' and point WORKER_PUBLIC_URL / VITE_WORKER_URL here (not the listener service)');
            }
        }
        const queueCfg = (0, signalQueueConfig_1.signalQueueConfig)();
        if (queueCfg.enabled && (0, signalQueueConfig_1.redisQueueConfigured)()) {
            if (queueCfg.shardCount > 1 && workerConfig_1.workerConfig.shardCount <= 1) {
                console.warn(`[worker] TRADE_SIGNAL_QUEUE_SHARD_COUNT=${queueCfg.shardCount} but this worker`
                    + ` is shard ${workerConfig_1.workerConfig.shardId} only — users on other shards need matching trade workers`);
            }
            if (workerConfig_1.workerConfig.shardId >= queueCfg.shardCount) {
                console.error(`[worker] FATAL: WORKER_SHARD_ID=${workerConfig_1.workerConfig.shardId} >= TRADE_SIGNAL_QUEUE_SHARD_COUNT=${queueCfg.shardCount}`);
                process.exit(1);
            }
            const tradeShards = (0, signalQueueConfig_1.deployedTradeShardCount)();
            if (queueCfg.shardCount > tradeShards && workerConfig_1.workerConfig.shardId === 0) {
                console.warn(`[worker] queue shard count (${queueCfg.shardCount}) > deployed trade shards (${tradeShards})`
                    + ' — set TRADE_SIGNAL_QUEUE_SHARD_COUNT=1 on listener and worker');
            }
            signalQueueConsumers = new signalQueueConsumer_1.SignalQueueConsumerManager(supabase, tradeExecutor);
            signalQueueConsumers.start();
            (0, queueHealth_1.setQueueMetricsProvider)(() => signalQueueConsumers.getMetrics());
            console.log('[worker] signal queue consumers started');
        }
        else if (queueCfg.enabled) {
            console.warn('[worker] TRADE_SIGNAL_QUEUE_ENABLED=true but Redis REST URL/token missing — queue disabled');
            (0, queueHealth_1.setQueueMetricsProvider)(null);
        }
    }
    else {
        sessionManager.setTradeExecutor(null);
    }
    if (workerConfig_1.workerConfig.runsListener) {
        // Register periodic lease renewal + session sync BEFORE (and independent of)
        // loadAll. Previously loadAll was awaited first, so a single hung listener
        // connect during startup (e.g. a wedged Telegram warm-up) blocked loadAll
        // forever, the renewal interval was never scheduled, and every lease expired
        // and never refreshed — taking the whole engine offline while the process
        // otherwise kept running. loadAll now runs in the background and adds
        // listeners as they connect; renewal keeps whatever is connected alive.
        setInterval(() => {
            void sessionManager.syncSessions();
        }, 30000);
        if (workerConfig_1.workerConfig.role === 'listener' || workerConfig_1.workerConfig.role === 'all') {
            setInterval(() => {
                void sessionManager.renewAllLeases();
            }, Math.max(10000, Number(process.env.WORKER_LEASE_RENEW_INTERVAL_MS ?? 20000)));
        }
        void sessionManager.loadAll().catch(err => console.error('[worker] loadAll failed:', err instanceof Error ? err.message : err));
        void sessionManager.startChannelListenerServices().catch(err => console.error('[worker] channel listener services failed:', err instanceof Error ? err.message : err));
    }
    else if (workerConfig_1.workerConfig.runsBacktestHttp) {
        console.log('[worker] backtest-only: no live Telegram listeners loaded');
    }
    const shutdown = async (signal) => {
        console.log(`[worker] ${signal} received, shutting down...`);
        httpServer?.close();
        authService?.shutdown();
        stopWorkWake?.();
        stopLogRetention?.();
        (0, queueHealth_1.setQueueMetricsProvider)(null);
        await signalQueueConsumers?.stop();
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
