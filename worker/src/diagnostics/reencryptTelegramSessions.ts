/**
 * Re-encrypt stored Telegram session strings under the CURRENT
 * TELEGRAM_SESSION_ENCRYPTION_KEY (rotation step 2 of 3).
 *
 * Rotation recipe:
 *
 *   1. Set env everywhere the worker runs:
 *        TELEGRAM_SESSION_ENCRYPTION_KEY=<new random 64-hex>
 *        TELEGRAM_SESSION_ENCRYPTION_KEY_PREVIOUS=<old value>
 *      Dual-key deploy first (reads try new, then previous; writes always use
 *      new). Plaintext rows are still readable during the rollout window.
 *   2. Run this diagnostic: dry-run first, then `--apply`.
 *   3. When the report shows `on-previous=0` and `plaintext=0` with no
 *      failures, delete TELEGRAM_SESSION_ENCRYPTION_KEY_PREVIOUS everywhere.
 *
 * Dry-run by default. Never logs plaintext — counts and user IDs only.
 *
 * Usage (worker env required):
 *   cd worker
 *   npx ts-node -r dotenv/config src/diagnostics/reencryptTelegramSessions.ts
 *   npx ts-node -r dotenv/config src/diagnostics/reencryptTelegramSessions.ts --apply
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import {
  isTelegramSessionCryptoConfigured,
  openTelegramSessionWithSource,
  sealTelegramSession,
  telegramSessionKeyFingerprints,
} from '../telegramSessionCrypto'

const APPLY = process.argv.includes('--apply')
const ALLOW_EMPTY = process.argv.includes('--allow-empty')
const PAGE_SIZE = 500

function argValue(name: string): string | null {
  const prefix = `${name}=`
  const found = process.argv.find(arg => arg.startsWith(prefix))
  return found ? found.slice(prefix.length).trim() || null : null
}

const EXPECTED_FINGERPRINT = argValue('--expect-primary-fingerprint')

function requireEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim()
  if (!value) {
    console.error(`[telegram-reencrypt] ${name} is required`)
    process.exit(1)
  }
  return value
}

requireEnv('SUPABASE_URL')
requireEnv('SUPABASE_SERVICE_ROLE_KEY')
requireEnv('TELEGRAM_SESSION_ENCRYPTION_KEY')

if (!isTelegramSessionCryptoConfigured()) {
  console.error('[telegram-reencrypt] TELEGRAM_SESSION_ENCRYPTION_KEY is empty or invalid')
  process.exit(1)
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const TARGET = (() => {
  try {
    return new URL(process.env.SUPABASE_URL!).host
  } catch {
    return '(unparseable SUPABASE_URL)'
  }
})()

interface Target {
  table: 'telegram_sessions' | 'telegram_auth_pending'
  column: 'session_string' | 'auth_session_string'
}

const TARGETS: Target[] = [
  { table: 'telegram_sessions', column: 'session_string' },
  { table: 'telegram_auth_pending', column: 'auth_session_string' },
]

interface PendingWrite {
  table: Target['table']
  userId: string
  column: string
  previousValue: string
  nextValue: string
}

interface Counters {
  scanned: number
  onPrimary: number
  onPrevious: number
  plaintext: number
  rewritten: number
  skippedTelethon: number
}

const counters: Counters = {
  scanned: 0,
  onPrimary: 0,
  onPrevious: 0,
  plaintext: 0,
  rewritten: 0,
  skippedTelethon: 0,
}
const failures: string[] = []
const pendingWrites: PendingWrite[] = []

async function scanTarget(target: Target): Promise<void> {
  let from = 0
  for (;;) {
    const columns = target.table === 'telegram_sessions'
      ? `user_id,listener_engine,${target.column}`
      : `user_id,${target.column}`
    const { data, error } = await supabase
      .from(target.table)
      .select(columns)
      .order('user_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error(`[telegram-reencrypt] failed to load ${target.table}:`, error.message)
      process.exit(1)
    }
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
    for (const row of rows) {
      const userId = String(row.user_id ?? '')
      const stored = typeof row[target.column] === 'string' ? String(row[target.column]) : ''
      if (!stored.trim()) continue

      // The Python (Telethon) listener reads this column raw and cannot open
      // the envelope. Nothing uses it today, but never seal a row it owns.
      if (target.table === 'telegram_sessions'
        && String(row.listener_engine ?? 'gramjs').toLowerCase() === 'telethon') {
        counters.skippedTelethon++
        continue
      }
      counters.scanned++

      let plaintext: string
      try {
        const opened = openTelegramSessionWithSource(stored)
        plaintext = opened.plaintext
        if (opened.keySource === 'primary') {
          counters.onPrimary++
          continue
        }
        if (opened.keySource === 'previous') {
          counters.onPrevious++
        } else {
          counters.plaintext++
        }
      } catch {
        failures.push(`${target.table}.${target.column}.${userId} (not decryptable with primary or previous key)`)
        continue
      }

      let resealed: string
      try {
        resealed = sealTelegramSession(plaintext)
      } catch (err) {
        failures.push(
          `${target.table}.${target.column}.${userId} (re-encrypt failed: `
          + `${err instanceof Error ? err.message : String(err)})`,
        )
        continue
      }

      pendingWrites.push({
        table: target.table,
        userId,
        column: target.column,
        previousValue: stored,
        nextValue: resealed,
      })
    }
    if (rows.length < PAGE_SIZE) return
    from += PAGE_SIZE
  }
}

async function applyWrites(): Promise<void> {
  for (const entry of pendingWrites) {
    const { data: updated, error } = await supabase
      .from(entry.table)
      .update({ [entry.column]: entry.nextValue })
      .eq('user_id', entry.userId)
      .eq(entry.column, entry.previousValue)
      .select('user_id')
    if (error) {
      failures.push(`${entry.table}.${entry.column}.${entry.userId} (update failed: ${error.message})`)
      continue
    }
    if (!updated || updated.length === 0) {
      failures.push(`${entry.table}.${entry.column}.${entry.userId} (changed concurrently — left for the next run)`)
      continue
    }
    counters.rewritten++
  }
}

async function main(): Promise<void> {
  const fingerprints = telegramSessionKeyFingerprints()
  console.log(`[telegram-reencrypt] target=${TARGET} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(
    `[telegram-reencrypt] primary-fingerprint=${fingerprints.primary ?? 'missing'} `
    + `previous-fingerprints=${fingerprints.previous.join(',') || 'none'}`,
  )

  // This is the one irreversible step of the rollout: sealing all rows under a
  // key no service holds would take every listener down. Refuse to write
  // unless the operator confirms the fingerprint the workers report.
  if (APPLY && !EXPECTED_FINGERPRINT) {
    console.error(
      '[telegram-reencrypt] --apply requires --expect-primary-fingerprint=<value> '
      + '(printed at worker startup) so a wrong key cannot seal every row.',
    )
    process.exit(1)
  }
  if (EXPECTED_FINGERPRINT && EXPECTED_FINGERPRINT !== fingerprints.primary) {
    console.error(
      `[telegram-reencrypt] aborting: primary fingerprint ${fingerprints.primary ?? 'missing'} `
      + `does not match expected ${EXPECTED_FINGERPRINT}`,
    )
    process.exit(1)
  }

  for (const target of TARGETS) {
    await scanTarget(target)
  }

  const toRewrite = pendingWrites.length
  if (APPLY) await applyWrites()

  console.log(
    `[telegram-reencrypt] values-scanned=${counters.scanned} on-primary=${counters.onPrimary} `
    + `on-previous=${counters.onPrevious} plaintext=${counters.plaintext} `
    + `skipped-telethon=${counters.skippedTelethon} `
    + `${APPLY ? 'rewritten' : 'would-rewrite'}=${APPLY ? counters.rewritten : toRewrite}`,
  )

  if (failures.length > 0) {
    console.error('[telegram-reencrypt] FAILED (those values were left untouched):')
    for (const failure of failures) console.error(`[telegram-reencrypt]   ${failure}`)
    process.exit(1)
  }
  if (counters.scanned === 0 && !ALLOW_EMPTY) {
    console.error(
      '[telegram-reencrypt] no session values scanned — wrong project or empty table; '
      + `refusing to report success (target=${TARGET}). Pass --allow-empty to override.`,
    )
    process.exit(2)
  }
  if (counters.onPrevious === 0 && counters.plaintext === 0) {
    console.log('[telegram-reencrypt] all values are on the primary key — safe to remove TELEGRAM_SESSION_ENCRYPTION_KEY_PREVIOUS.')
  } else if (!APPLY) {
    console.log(
      `[telegram-reencrypt] dry-run only — ${counters.onPrevious + counters.plaintext} value(s) need sealing; `
      + 're-run with --apply to write.',
    )
  } else {
    console.log(
      `[telegram-reencrypt] ${counters.onPrevious + counters.plaintext} value(s) were rewritten — `
      + 're-run to confirm on-previous=0 and plaintext=0.',
    )
  }
}

main().catch((error) => {
  console.error('[telegram-reencrypt] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
