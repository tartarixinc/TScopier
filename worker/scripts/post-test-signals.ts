/**
 * Automated test-signal poster.
 * Posts every signal format to the SIGNALS TESTER channel on staging,
 * waits between each for verification, and logs results.
 *
 * Usage (from worker/):
 *   SUPABASE_URL=https://axdcledcyhyvzrnfkwat.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   TELEGRAM_API_ID=30670916 \
 *   TELEGRAM_API_HASH=469129b31e84d3b21d319d18abebf9d7 \
 *   node --require ts-node/register scripts/post-test-signals.ts
 *
 * Options:
 *   DRY_RUN=true   — print what would be posted without sending
 *   INTERVAL_MS=3000 — ms between signals (default 4000)
 *   CHANNEL_ID=-1003962048504 — target channel (default SIGNALS TESTER)
 */
import { createClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions'
import { openTelegramSession } from '../src/telegramSessionCrypto'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const API_ID = parseInt(process.env.TELEGRAM_API_ID ?? '30670916')
const API_HASH = process.env.TELEGRAM_API_HASH ?? ''
const CHANNEL_ID = process.env.CHANNEL_ID ?? '-1003962048504'
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS ?? '4000')
const DRY_RUN = process.env.DRY_RUN === 'true'

interface TestSignal {
  label: string
  tc: string
  message: string
}

const TEST_SIGNALS: TestSignal[] = [
  // 2.1 Standard entry
  { label: 'Standard entry', tc: 'TC15', message: 'BUY XAUUSD 1.00 SL 3980 TP 4000' },

  // 2.2 Entry with zone
  { label: 'Zone entry', tc: 'TC16', message: 'SELL XAUUSD 3950-3960 SL 3980 TP 3930 TP 3910' },

  // 2.3 SL inside TP ladder (invalid — should reject)
  { label: 'Invalid SL inside TP ladder', tc: 'TC17', message: 'BUY XAUUSD 1.00 SL 4020 TP 4030 TP 4050' },

  // 2.4 Naked entry (no stops)
  { label: 'Naked entry no stops', tc: 'TC18', message: 'BUY XAUUSD 1.00' },

  // 2.5 Dot-leader format
  { label: 'Dot-leader', tc: 'TC19', message: 'Sell.........4080\nSl.............4090\nTp............4071' },

  // 2.6 Management — Adjust SL
  { label: 'Adjust SL', tc: 'TC21', message: 'Adjust SL to 3940' },

  // 2.7 Management — Breakeven
  { label: 'Breakeven', tc: 'TC22', message: 'BE at 3970' },

  // 2.8 Management — Close
  { label: 'Close', tc: 'TC23', message: 'CLOSE XAUUSD at 4010' },

  // 2.9 Close worse entries
  { label: 'Close worse entries', tc: 'TC24', message: 'Close worse entries' },

  // 2.10 will be tested separately (edit existing message)
  // 2.11 Multi-TP ladder
  { label: 'Multi-TP ladder', tc: 'TC25', message: 'BUY XAUUSD 1.00 SL 3980 TP 4000 / TP 4020 / TP 4040 / TP 4060' },

  // 2.12 Underscore format
  { label: 'Underscore format', tc: 'TC20', message: 'XAUUSD_BUY 1.00 SL 3980 TP 4000' },

  // 2.13 Daily bias / chatter (non-actionable)
  { label: 'Chatter non-actionable', tc: 'TC26', message: 'BIAS: Bullish above 3950, bearish below' },
]

function redact(s: string): string {
  if (s.length > 12) return s.slice(0, 6) + '...' + s.slice(-6)
  return s
}

async function main() {
  console.log('=== TScopier Test Signal Poster ===')
  console.log(`Target channel: ${CHANNEL_ID}`)
  console.log(`Interval: ${INTERVAL_MS}ms`)
  console.log(`DRY_RUN: ${DRY_RUN}`)
  console.log(`Signals to post: ${TEST_SIGNALS.length}`)

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
    process.exit(1)
  }
  if (!API_ID || !API_HASH) {
    console.error('FATAL: TELEGRAM_API_ID and TELEGRAM_API_HASH are required')
    process.exit(1)
  }

  // 1. Fetch a real session string
  console.log('\n[1/3] Fetching session from Supabase...')
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const { data: sessions, error } = await supabase
    .from('telegram_sessions')
    .select('user_id, session_string')
    .not('session_string', 'eq', '')
    .limit(1)

  if (error) {
    console.error('Supabase error:', error.message)
    process.exit(1)
  }
  if (!sessions || sessions.length === 0) {
    console.error('No real sessions found')
    process.exit(1)
  }

  const session = sessions[0]
  const sessionString = openTelegramSession(session.session_string)
  console.log(`  Using session: user=${session.user_id} fp=${redact(sessionString)}`)

  // 2. Connect to Telegram
  console.log('\n[2/3] Connecting to Telegram...')
  const client = new TelegramClient(
    new StringSession(sessionString),
    API_ID,
    API_HASH,
    {
      connectionRetries: 3,
      retryDelay: 2000,
      autoReconnect: false,
      useWSS: true,
      deviceModel: 'Desktop',
      systemVersion: 'Windows 10',
      appVersion: '5.6.3',
      langCode: 'en',
      systemLangCode: 'en',
      floodSleepThreshold: 60,
    }
  )

  await client.connect()
  console.log('  Connected to Telegram')

  // 3. Post signals
  console.log(`\n[3/3] Posting ${TEST_SIGNALS.length} signals...`)
  let pass = 0
  let fail = 0

  for (const sig of TEST_SIGNALS) {
    console.log(`\n--- ${sig.tc}: ${sig.label} ---`)
    console.log(`  Message: ${sig.message.replace(/\n/g, '\\n')}`)

    if (DRY_RUN) {
      console.log('  [DRY RUN — skipped]')
      pass++
      continue
    }

    try {
      const result = await client.sendMessage(CHANNEL_ID, { message: sig.message })
      const msgId = result?.id ?? 'unknown'
      console.log(`  Sent! message_id=${msgId}`)
      pass++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  FAILED: ${msg}`)
      fail++
    }

    if (sig !== TEST_SIGNALS[TEST_SIGNALS.length - 1]) {
      console.log(`  Waiting ${INTERVAL_MS}ms before next...`)
      await new Promise(r => setTimeout(r, INTERVAL_MS))
    }
  }

  // 4. Cleanup
  await client.disconnect()
  console.log('\n=== Done ===')
  console.log(`Pass: ${pass}  Fail: ${fail}  Total: ${TEST_SIGNALS.length}`)
  if (fail > 0) process.exit(1)
}

main().catch(err => {
  console.error('FATAL:', err)
  process.exit(1)
})
