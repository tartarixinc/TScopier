"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Replay channel parse locally (loads keywords + lexicon from Supabase).
 *
 * Usage (from worker/):
 *   npx ts-node -r dotenv/config src/diagnostics/replayChannelParse.ts \
 *     --channel-id UUID --message "BUY XAUUSD NOW SL 2650 TP 2700"
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
const supabase_js_1 = require("@supabase/supabase-js");
const parseSignal_1 = require("../parseSignal");
const signalTradingHeuristic_1 = require("../signalTradingHeuristic");
function parseArgs(argv) {
    let channelId = '';
    let message = '';
    let telethonHeuristic = false;
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--channel-id' && argv[i + 1]) {
            channelId = argv[++i];
        }
        else if (arg === '--message' && argv[i + 1]) {
            message = argv[++i];
        }
        else if (arg === '--message-file' && argv[i + 1]) {
            const fs = require('fs');
            message = fs.readFileSync(argv[++i], 'utf8').trim();
        }
        else if (arg === '--telethon-heuristic') {
            telethonHeuristic = true;
        }
        else if (arg === '--help' || arg === '-h') {
            console.log(`Usage: replayChannelParse.ts --channel-id UUID --message "..." [--telethon-heuristic]`);
            process.exit(0);
        }
    }
    if (!channelId || !message) {
        console.error('Required: --channel-id and --message (or --message-file)');
        process.exit(1);
    }
    return { channelId, message, telethonHeuristic };
}
async function main() {
    const { channelId, message, telethonHeuristic } = parseArgs(process.argv);
    const url = String(process.env.SUPABASE_URL ?? '').trim();
    const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
    if (!url || !key) {
        console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
        process.exit(1);
    }
    const supabase = (0, supabase_js_1.createClient)(url, key);
    const [keywords, lexicon] = await Promise.all([
        (0, parseSignal_1.loadChannelKeywords)(supabase, channelId),
        (0, parseSignal_1.loadChannelLexicon)(supabase, channelId),
    ]);
    const { data: channelRow } = await supabase
        .from('telegram_channels')
        .select('display_name, channel_username')
        .eq('id', channelId)
        .maybeSingle();
    const result = (0, parseSignal_1.parseChannelMessageSync)(message, keywords, lexicon);
    const out = {
        channel_id: channelId,
        channel_name: channelRow?.display_name ?? null,
        message_preview: message.length > 120 ? `${message.slice(0, 120)}…` : message,
        heuristic_ts: (0, signalTradingHeuristic_1.looksLikeTradingSignal)(message, false, { keywords, lexicon }),
        parse: result,
    };
    if (telethonHeuristic) {
        out.note = 'Telethon listener uses the same TS-aligned scoring in signal_heuristic.py';
    }
    console.log(JSON.stringify(out, null, 2));
}
void main().catch(err => {
    console.error(err);
    process.exit(1);
});
