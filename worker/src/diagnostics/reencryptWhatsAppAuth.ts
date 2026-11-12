/**
 * Re-encrypt stored WhatsApp auth payloads (whatsapp_auth.creds / keys) under
 * the CURRENT WHATSAPP_AUTH_ENCRYPTION_KEY (rotation step 2 of 3).
 *
 * Rotation recipe:
 *
 *   1. Deploy the reader/writer code first (dual-format read; writes sealed
 *      only when the key is configured), then set env on every WhatsApp
 *      listener process:
 *        WHATSAPP_AUTH_ENCRYPTION_KEY=<new random 64-hex>
 *        WHATSAPP_AUTH_ENCRYPTION_KEY_PREVIOUS=<old value>   (rotations only)
 *      Plaintext rows stay readable during the rollout window.
 *   2. Run this diagnostic: dry-run first, then `--apply`.
 *   3. When the report shows `on-previous=0` and `plaintext=0` with no
 *      failures, delete WHATSAPP_AUTH_ENCRYPTION_KEY_PREVIOUS everywhere.
 *
 * Dry-run by default. Never logs payload contents — counts and user IDs only.
 *
 * Usage (worker env required):
 *   cd worker
 *   npx ts-node -r dotenv/config src/diagnostics/reencryptWhatsAppAuth.ts
 *   npx ts-node -r dotenv/config src/diagnostics/reencryptWhatsAppAuth.ts --apply
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import {
  isWhatsAppAuthCryptoConfigured,
  openWhatsAppAuthWithSource,
  sealWhatsAppAuth,
  whatsappAuthKeyFingerprints,
} from '../whatsappAuthCrypto'

const APPLY = process.argv.includes('--apply')
const ALLOW_EMPTY = process.argv.includes('--allow-empty')
const PAGE_SIZE = 200

function argValue(name: string): string | null {
  const prefix = `${name}=`
  const found = process.argv.find(arg => arg.startsWith(prefix))
  return found ? found.slice(prefix.length).trim() || null : null
}

const EXPECTED_FINGERPRINT = argValue('--expect-primary-fingerprint')

function requireEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim()
  if (!value) {
    console.error(`[whatsapp-reencrypt] ${name} is required`)
    process.exit(1)
  }
  return value
}

requireEnv('SUPABASE_URL')
requireEnv('SUPABASE_SERVICE_ROLE_KEY')
requireEnv('WHATSAPP_AUTH_ENCRYPTION_KEY')

if (!isWhatsAppAuthCryptoConfigured()) {
  console.error('[whatsapp-reencrypt] WHATSAPP_AUTH_ENCRYPTION_KEY is empty or invalid')
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

const TABLE = 'whatsapp_auth'
const COLUMNS = ['creds', 'keys'] as const

interface PendingWrite {
  userId: string
  previousUpdatedAt: string
  nextValues: Record<string, string>
}

interface Counters {
  scanned: number
  onPrimary: number
  onPrevious: number
  plaintext: number
  rewritten: number
}

const counters: Counters = { scanned: 0, onPrimary: 0, onPrevious: 0, plaintext: 0, rewritten: 0 }
const failures: string[] = []
const pendingWrites: PendingWrite[] = []

interface Classified {
  jsonText: string
  reseal: boolean
}

function classify(value: unknown, label: string, userId: string): Classified | null {
  if (value == null) return null
  if (typeof value !== 'string') {
    // Legacy plaintext object stored in the jsonb column.
    counters.scanned++
    counters.plaintext++
    return { jsonText: JSON.stringify(value), reseal: true }
  }
  if (!value.trim()) return null

  counters.scanned++
  try {
    const opened = openWhatsAppAuthWithSource(value)
    if (opened.keySource === 'primary') {
      counters.onPrimary++
      return { jsonText: opened.plaintext, reseal: false }
    }
    if (opened.keySource === 'previous') counters.onPrevious++
    else counters.plaintext++
    return { jsonText: opened.plaintext, reseal: true }
  } catch {
    failures.push(`${TABLE}.${label}.${userId} (not decryptable with primary or previous key)`)
    return null
  }
}

async function scanRows(): Promise<void> {
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('user_id, creds, keys, updated_at')
      .order('user_id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error(`[whatsapp-reencrypt] failed to load ${TABLE}:`, error.message)
      process.exit(1)
    }
    const rows = (data ?? []) as Array<{
      user_id: string
      creds: unknown
      keys: unknown
      updated_at: string
    }>
    for (const row of rows) {
      const userId = String(row.user_id ?? '')
      const nextValues: Record<string, string> = {}
      for (const column of COLUMNS) {
        const classified = classify(row[column], column, userId)
        if (!classified?.reseal) continue
        try {
          nextValues[column] = sealWhatsAppAuth(classified.jsonText)
        } catch (err) {
          failures.push(
            `${TABLE}.${column}.${userId} (re-encrypt failed: `
            + `${err instanceof Error ? err.message : String(err)})`,
          )
        }
      }
      if (Object.keys(nextValues).length > 0) {
        pendingWrites.push({
          userId,
          previousUpdatedAt: String(row.updated_at ?? ''),
          nextValues,
        })
      }
    }
    if (rows.length < PAGE_SIZE) return
    from += PAGE_SIZE
  }
}

async function applyWrites(): Promise<void> {
  for (const entry of pendingWrites) {
    const { data: updated, error } = await supabase
      .from(TABLE)
      .update({ ...entry.nextValues, updated_at: new Date().toISOString() })
      .eq('user_id', entry.userId)
      .eq('updated_at', entry.previousUpdatedAt)
      .select('user_id')
    if (error) {
      failures.push(`${TABLE}.${entry.userId} (update failed: ${error.message})`)
      continue
    }
    if (!updated || updated.length === 0) {
      failures.push(`${TABLE}.${entry.userId} (changed concurrently — left for the next run)`)
      continue
    }
    counters.rewritten += Object.keys(entry.nextValues).length
  }
}

async function main(): Promise<void> {
  const fingerprints = whatsappAuthKeyFingerprints()
  console.log(`[whatsapp-reencrypt] target=${TARGET} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(
    `[whatsapp-reencrypt] primary-fingerprint=${fingerprints.primary ?? 'missing'} `
    + `previous-fingerprints=${fingerprints.previous.join(',') || 'none'}`,
  )

  // Sealing rows under a key no service holds would break every linked WhatsApp
  // account. Refuse to write unless the operator confirms the fingerprint the
  // listeners report at boot.
  if (APPLY && !EXPECTED_FINGERPRINT) {
    console.error(
      '[whatsapp-reencrypt] --apply requires --expect-primary-fingerprint=<value> '
      + '(printed at listener startup) so a wrong key cannot seal every row.',
    )
    process.exit(1)
  }
  if (EXPECTED_FINGERPRINT && EXPECTED_FINGERPRINT !== fingerprints.primary) {
    console.error(
      `[whatsapp-reencrypt] aborting: primary fingerprint ${fingerprints.primary ?? 'missing'} `
      + `does not match expected ${EXPECTED_FINGERPRINT}`,
    )
    process.exit(1)
  }

  await scanRows()

  // All counters count *values* (creds and keys separately), so the rewrite
  // total must too — not rows.
  const toRewrite = pendingWrites.reduce((total, entry) => total + Object.keys(entry.nextValues).length, 0)
  if (APPLY) await applyWrites()

  console.log(
    `[whatsapp-reencrypt] values-scanned=${counters.scanned} on-primary=${counters.onPrimary} `
    + `on-previous=${counters.onPrevious} plaintext=${counters.plaintext} `
    + `${APPLY ? 'rewritten' : 'would-rewrite'}=${APPLY ? counters.rewritten : toRewrite}`,
  )

  if (failures.length > 0) {
    console.error('[whatsapp-reencrypt] FAILED (those values were left untouched):')
    for (const failure of failures) console.error(`[whatsapp-reencrypt]   ${failure}`)
    process.exit(1)
  }
  if (counters.scanned === 0 && !ALLOW_EMPTY) {
    console.error(
      '[whatsapp-reencrypt] no auth values scanned — wrong project or empty table; '
      + `refusing to report success (target=${TARGET}). Pass --allow-empty to override.`,
    )
    process.exit(2)
  }
  if (counters.onPrevious === 0 && counters.plaintext === 0) {
    console.log('[whatsapp-reencrypt] all values are on the primary key — safe to remove WHATSAPP_AUTH_ENCRYPTION_KEY_PREVIOUS.')
  } else if (!APPLY) {
    console.log(
      `[whatsapp-reencrypt] dry-run only — ${counters.onPrevious + counters.plaintext} value(s) need sealing; `
      + 're-run with --apply to write.',
    )
  } else {
    console.log(
      `[whatsapp-reencrypt] ${counters.onPrevious + counters.plaintext} value(s) were rewritten — `
      + 're-run to confirm on-previous=0 and plaintext=0.',
    )
  }
}

main().catch((error) => {
  console.error('[whatsapp-reencrypt] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
