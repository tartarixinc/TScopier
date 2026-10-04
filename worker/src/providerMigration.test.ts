import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const migration = readFileSync(
  resolve(__dirname, '../../supabase/migrations/20260914120000_add_broker_accounts_provider.sql'),
  'utf8',
).replace(/\s+/g, ' ').toLowerCase()

test('provider migration defaults to fxsocket and permits only known providers', () => {
  assert.match(migration, /provider text not null default 'fxsocket'/)
  assert.match(migration, /check \(provider in \('fxsocket', 'mtapi'\)\)/)
})
