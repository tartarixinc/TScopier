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
const managementWorker_1 = require("./managementWorker");
// Supabase Realtime needs a WebSocket transport in Node < 22.
// Railway is currently running Node 20, so we provide ws explicitly.
if (!globalThis.WebSocket) {
    globalThis.WebSocket = ws_1.default;
}
const supabase = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const sessionManager = new sessionManager_1.UserSessionManager(supabase);
const authService = new authService_1.AuthService(supabase, sessionManager);
const httpServer = (0, httpServer_1.startHttpServer)(authService, sessionManager);
const managementWorker = new managementWorker_1.ManagementWorker(supabase);
async function main() {
    console.log('[worker] TSCopier AI worker starting...');
    await sessionManager.loadAll();
    managementWorker.start();
    setInterval(async () => {
        await sessionManager.syncSessions();
    }, 30000);
    const shutdown = async (signal) => {
        console.log(`[worker] ${signal} received, shutting down...`);
        httpServer.close();
        authService.shutdown();
        managementWorker.stop();
        await sessionManager.disconnectAll();
        process.exit(0);
    };
    process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
    process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
}
main().catch(err => {
    console.error('[worker] Fatal error:', err);
    process.exit(1);
});
