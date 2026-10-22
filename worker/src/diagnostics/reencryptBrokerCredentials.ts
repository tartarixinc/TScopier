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
 *   3. When the report shows 0 values still on the old key, delete
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
import { decryptMtPassword, encryptMtPassword } from '../brokerCredentialsCrypto'

const APPLY = process.argv.includes('--apply')

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

interface EncryptedRow {
  id: string
  [column: string]: unknown
}

async function main(): Promise<void> {
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('*')
  if (error) {
    console.error('[reencrypt] failed to load broker_accounts:', error.message)
    process.exit(1)
  }
  const rows = (data ?? []) as EncryptedRow[]

  let scanned = 0
  let rewritten = 0
  let unchanged = 0
  const failures: string[] = []
  const perRow: Array<{ id: string; columns: string[] }> = []

  for (const row of rows) {
    const patch: Record<string, string> = {}
    const touched: string[] = []
    for (const [column, raw] of Object.entries(row)) {
      if (!column.endsWith('_encrypted')) continue
      const value = typeof raw === 'string' ? raw.trim() : ''
      if (!value || !value.startsWith('v1:')) continue
      scanned++

      const plaintext = decryptMtPassword(value)
      if (plaintext == null) {
        // Undecryptable with primary+previous: never overwrite — report so the
        // old key list can be checked before anything is destroyed.
        failures.push(`${row.id}.${column}`)
        continue
      }
      const resealed = encryptMtPassword(plaintext)
      if (!resealed) {
        failures.push(`${row.id}.${column} (re-encrypt returned null)`)
        continue
      }
      if (resealed === value) {
        unchanged++
        continue
      }
      patch[column] = resealed
      touched.push(column)
    }

    if (Object.keys(patch).length === 0) continue
    perRow.push({ id: row.id, columns: touched })

    if (APPLY) {
      const { error: updateError } = await supabase
        .from('broker_accounts')
        .update(patch)
        .eq('id', row.id)
      if (updateError) {
        failures.push(`${row.id} (update failed: ${updateError.message})`)
        continue
      }
    }
    rewritten++
  }

  console.log(`[reencrypt] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`)
  console.log(`[reencrypt] accounts=${rows.length} values-scanned=${scanned} already-on-new-key=${unchanged} ${APPLY ? 'rewritten' : 'would-rewrite'}=${rewritten}`)
  if (perRow.length > 0) {
    for (const entry of perRow) {
      console.log(`[reencrypt]   ${APPLY ? 'rewrote' : 'would rewrite'} ${entry.id}: ${entry.columns.join(', ')}`)
    }
  }
  if (failures.length > 0) {
    console.error(`[reencrypt] FAILED (left untouched, check BROKER_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS):`)
    for (const failure of failures) console.error(`[reencrypt]   ${failure}`)
    process.exit(1)
  }
  if (!APPLY && rewritten > 0) {
    console.log('[reencrypt] dry-run only — re-run with --apply to write.')
  }
}

void main()
