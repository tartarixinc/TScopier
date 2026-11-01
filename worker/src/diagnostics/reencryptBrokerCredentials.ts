/**
 * Re-encrypt stored broker credentials under the CURRENT
 * BROKER_CREDENTIALS_ENCRYPTION_KEY (rotation step 2 of 3).
 *
 * The encryption key is not a login — every value it sealed in
 * `broker_accounts.*_encrypted` only opens with the old key. Rotation recipe:
 *
 *   1. Set env everywhere (worker/VPS + Supabase edge secrets):
 *        BROKER_CREDENTIALS_ENCRYPTION_KEY=<new random 64-hex>
 *        BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS=<old value>
 *      Dual-key deploy required first (decrypt tries new, falls back to old;
 *      encrypt always uses new).
 *   2. Run this diagnostic: dry-run first, then `--apply`.
 *   3. When the report shows `on-previous=0` and no failures, delete
 *      BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS everywhere.
 *
 * Dry-run by default. Never logs plaintext — counts and column names only.
 *
 * Usage (worker env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * BROKER_CREDENTIALS_ENCRYPTION_KEY, BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS):
 *   cd worker
 *   npx ts-node -r dotenv/config src/diagnostics/reencryptBrokerCredentials.ts
 *   npx ts-node -r dotenv/config src/diagnostics/reencryptBrokerCredentials.ts --apply
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import {
  brokerCredentialKeyFingerprints,
  decryptMtPasswordWithSource,
  encryptMtPassword,
} from '../brokerCredentialsCrypto'

const APPLY = process.argv.includes('--apply')
const ALLOW_EMPTY = process.argv.includes('--allow-empty')
const PAGE_SIZE = 500

function requireEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim()
  if (!value) {
    console.error(`[reencrypt] ${name} is required`)
    process.exit(1)
  }
  return value
}

requireEnv('SUPABASE_URL')
requireEnv('SUPABASE_SERVICE_ROLE_KEY')
requireEnv('BROKER_CREDENTIALS_ENCRYPTION_KEY')
requireEnv('BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS')

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const TARGET = (() => {
  try {
    return new URL(requireEnv('SUPABASE_URL')).host
  } catch {
    return '(unparseable SUPABASE_URL)'
  }
})()

interface EncryptedRow {
  id: string
  [column: string]: unknown
}

interface PendingWrite {
  column: string
  previousValue: string
  nextValue: string
}

/**
 * Read every broker account in deterministic pages. PostgREST caps a single
 * response (Supabase default 1000 rows), so one unbounded `select('*')` can
 * silently stop early and leave rows unrotated.
 */
async function loadAllRows(): Promise<EncryptedRow[]> {
  const rows: EncryptedRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('broker_accounts')
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error('[reencrypt] failed to load broker_accounts:', error.message)
      process.exit(1)
    }
    const page = (data ?? []) as EncryptedRow[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
    from += PAGE_SIZE
  }
}

async function main(): Promise<void> {
  const fingerprints = brokerCredentialKeyFingerprints()
  console.log(`[reencrypt] target=${TARGET} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(
    `[reencrypt] primary-fingerprint=${fingerprints.primary ?? 'missing'} `
    + `previous-fingerprints=${fingerprints.previous.join(',') || 'none'}`,
  )

  const rows = await loadAllRows()

  let scanned = 0
  let onPrimary = 0
  let onPrevious = 0
  let rewritten = 0
  const failures: string[] = []
  const nonV1: string[] = []
  const perRow: Array<{ id: string; columns: string[] }> = []

  for (const row of rows) {
    const pending: PendingWrite[] = []
    for (const [column, raw] of Object.entries(row)) {
      if (!column.endsWith('_encrypted')) continue
      const stored = typeof raw === 'string' ? raw : ''
      const value = stored.trim()
      if (!value) continue
      if (!value.startsWith('v1:')) {
        // Unknown or truncated format: never touch it, but never report the
        // rotation as complete while it is present either.
        nonV1.push(`${row.id}.${column}`)
        continue
      }
      scanned++

      const decrypted = decryptMtPasswordWithSource(value)
      if (decrypted == null) {
        // Undecryptable with primary+previous: never overwrite — report so the
        // old key list can be checked before anything is destroyed.
        failures.push(`${row.id}.${column} (not decryptable with primary or previous key)`)
        continue
      }
      if (decrypted.keySource === 'primary') {
        onPrimary++
        continue
      }
      onPrevious++
      const resealed = encryptMtPassword(decrypted.plaintext)
      if (!resealed) {
        failures.push(`${row.id}.${column} (re-encrypt returned null)`)
        continue
      }
      pending.push({ column, previousValue: stored, nextValue: resealed })
    }

    if (pending.length === 0) continue
    perRow.push({ id: row.id, columns: pending.map(entry => entry.column) })

    if (!APPLY) {
      rewritten += pending.length
      continue
    }

    for (const entry of pending) {
      // Compare-and-swap on the exact stored ciphertext: a password changed by
      // the user between our read and this write must not be overwritten with
      // a stale plaintext.
      const { data: updated, error: updateError } = await supabase
        .from('broker_accounts')
        .update({ [entry.column]: entry.nextValue })
        .eq('id', row.id)
        .eq(entry.column, entry.previousValue)
        .select('id')
      if (updateError) {
        failures.push(`${row.id}.${entry.column} (update failed: ${updateError.message})`)
        continue
      }
      if (!updated || updated.length === 0) {
        failures.push(`${row.id}.${entry.column} (changed concurrently — left for the next run)`)
        continue
      }
      rewritten++
    }
  }

  console.log(
    `[reencrypt] accounts=${rows.length} values-scanned=${scanned} on-primary=${onPrimary} `
    + `on-previous=${onPrevious} skipped-non-v1=${nonV1.length} `
    + `${APPLY ? 'rewritten' : 'would-rewrite'}=${rewritten}`,
  )
  for (const entry of perRow) {
    console.log(`[reencrypt]   ${APPLY ? 'rewrote' : 'would rewrite'} ${entry.id}: ${entry.columns.join(', ')}`)
  }

  if (failures.length > 0) {
    console.error('[reencrypt] FAILED (those values were left untouched):')
    for (const failure of failures) console.error(`[reencrypt]   ${failure}`)
    process.exit(1)
  }
  if (nonV1.length > 0) {
    console.error('[reencrypt] values in an unrecognised format were left untouched:')
    for (const entry of nonV1) console.error(`[reencrypt]   ${entry}`)
    process.exit(1)
  }
  if (scanned === 0 && !ALLOW_EMPTY) {
    console.error(
      '[reencrypt] no encrypted values scanned — wrong project or empty table; '
      + `refusing to report success (target=${TARGET}). Pass --allow-empty to override.`,
    )
    process.exit(2)
  }
  if (onPrevious === 0) {
    console.log('[reencrypt] on-previous=0 — safe to remove BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS.')
  } else if (!APPLY) {
    console.log(`[reencrypt] dry-run only — ${onPrevious} value(s) still on a previous key; re-run with --apply to write.`)
  } else {
    console.log(`[reencrypt] ${onPrevious} value(s) were on a previous key — re-run to confirm on-previous=0 before removing it.`)
  }
}

main().catch((error) => {
  console.error('[reencrypt] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
