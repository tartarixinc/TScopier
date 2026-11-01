import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

const dir = new URL('../../supabase/migrations/', import.meta.url)
const read = (suffix: string) => {
  const file = readdirSync(dir).find(name => name.endsWith(suffix))
  assert.ok(file, `migration ending in ${suffix} must exist`)
  return readFileSync(new URL(file, dir), 'utf8')
}
const schema = read('_provider_schema.sql')
const rpcs = read('_provider_rpcs.sql')
const adminList = read('_provider_admin_list.sql')

test('provider_applications is owner/admin readable and never directly writable', () => {
  assert.match(schema, /alter table public\.provider_applications enable row level security/)
  assert.match(schema, /for select to authenticated using \(user_id = auth\.uid\(\)\)/)
  assert.match(schema, /for select to authenticated using \(public\.is_admin\(\)\)/)
  assert.match(schema, /revoke all on public\.provider_applications from anon, authenticated/)
  assert.match(schema, /grant select on public\.provider_applications to authenticated/)
  assert.doesNotMatch(schema, /for (insert|update|delete)/i)
  assert.doesNotMatch(schema, /grant (insert|update|delete)[^;]*provider_applications/i)
})

test('application statuses and slug rules are constrained in the database', () => {
  assert.match(schema, /status in \('draft', 'pending', 'approved', 'rejected', 'suspended'\)/)
  assert.match(schema, /provider_status in \('none', 'pending', 'approved', 'rejected', 'suspended'\)/)
  assert.match(schema, /slug ~ '\^\[a-z0-9\]\[a-z0-9-\]\{1,38\}\[a-z0-9\]\$'/)
  assert.match(schema, /create unique index if not exists social_profiles_slug_key/)
  assert.match(schema, /\('x', 'instagram', 'telegram'/)
  assert.match(schema, /'provider_application_approved'/)
})

test('only admins can decide an application and every decision is audited and notified', () => {
  const review = rpcs.slice(rpcs.indexOf('function public.admin_review_provider_application'), rpcs.indexOf('function public.update_provider_profile'))
  assert.match(review, /if not public\.is_admin\(\) then raise exception 'Admin access required' using errcode = '42501'/)
  assert.match(review, /provider_audit\(/)
  assert.match(review, /provider_notify\(/)
  assert.match(review, /A rejection reason is required/)
  assert.match(review, /Only pending applications can be approved/)
  assert.match(adminList, /if not public\.is_admin\(\)/)
})

test('applicant RPCs are authenticated-only and the public profile is the only anon grant', () => {
  for (const fn of [
    'save_provider_draft\\(uuid, text, text, integer, text, text, jsonb\\)',
    'get_my_provider_application\\(\\)',
    'submit_provider_application\\(boolean\\)',
    'admin_review_provider_application\\(uuid, text, text, text\\)',
    'update_provider_profile\\(integer, text, text, jsonb\\)',
    'refresh_social_source_snapshot\\(uuid\\)',
  ]) {
    assert.match(rpcs, new RegExp(`revoke all on function public\\.${fn} from public, anon`), `${fn} must be revoked from anon`)
  }
  assert.match(rpcs, /grant execute on function public\.get_provider_public_profile\(text\) to anon, authenticated/)
  assert.doesNotMatch(rpcs, /grant execute on function public\.(?!get_provider_public_profile)[a-z_]+\([^)]*\) to anon/)
  assert.match(rpcs, /revoke all on function public\.provider_audit\(uuid, text, text, jsonb, jsonb\) from public, anon, authenticated/)
  assert.match(rpcs, /revoke all on function public\.refresh_social_source_snapshots_internal\(uuid\) from public, anon, authenticated/)
})

test('publishing a copy source requires an approved provider and an eligible account', () => {
  const publish = rpcs.slice(rpcs.indexOf('function public.publish_social_copy_source'), rpcs.indexOf('drop function if exists public.get_social_directory'))
  assert.match(publish, /provider_status = 'approved'/)
  assert.match(publish, /provider_account_ineligibility\(v_actor, p_broker_account_id\) is not null/)
  assert.match(publish, /refresh_social_source_snapshots_internal\(v_id\)/)
})

test('submission validates the account, terms, price and declared type server-side', () => {
  const submit = rpcs.slice(rpcs.indexOf('function public.submit_provider_application'), rpcs.indexOf('function public.admin_review_provider_application'))
  assert.match(submit, /p_accept_terms is not true/)
  assert.match(submit, /provider_account_ineligibility\(v_actor, v_app\.broker_account_id\)/)
  assert.match(submit, /Declared account type does not match the connected account/)
  assert.match(submit, /Enter the prop firm name/)
  assert.match(submit, /Set a price \(0 for free\)/)
  assert.match(submit, /submit_count >= 10/)
})

test('public profile exposes only approved, listed, non-synthetic providers', () => {
  const profile = rpcs.slice(rpcs.indexOf('function public.get_provider_public_profile'), rpcs.indexOf('-- Grants') === -1 ? undefined : rpcs.indexOf('revoke all on function public.save_provider_draft'))
  assert.match(profile, /sp\.provider_status = 'approved'/)
  assert.match(profile, /sp\.is_listed = true/)
  assert.match(profile, /sp\.is_synthetic_demo = false/)
  assert.doesNotMatch(profile, /email|broker_account_id|account_login/)
})

const publicPerf = read('_provider_public_performance.sql')

test('public performance and history are anon-readable only through the slug-gated, share-gated RPCs', () => {
  assert.match(publicPerf, /grant execute on function public\.get_provider_public_performance\(text\) to anon, authenticated/)
  assert.match(publicPerf, /grant execute on function public\.get_provider_public_trade_history\(text, integer\) to anon, authenticated/)
  // Internal helpers are never callable by clients.
  assert.match(publicPerf, /revoke all on function public\.provider_public_source_trades\(uuid\) from public, anon, authenticated/)
  assert.match(publicPerf, /revoke all on function public\.provider_public_shared_source\(text\) from public, anon, authenticated/)
  assert.doesNotMatch(publicPerf, /grant execute on function public\.provider_public_(source_trades|shared_source)/)
  // Visibility: approved + listed + non-synthetic + the provider's Share trade history toggle.
  const resolver = publicPerf.slice(publicPerf.indexOf('function public.provider_public_shared_source'), publicPerf.indexOf('function public.get_provider_public_performance'))
  assert.match(resolver, /sp\.provider_status = 'approved'/)
  assert.match(resolver, /sp\.is_listed = true/)
  assert.match(resolver, /sp\.is_synthetic_demo = false/)
  assert.match(resolver, /sp\.share_trade_history/)
})

test('public RPCs return no metrics or trades unless the provider shares trade history', () => {
  const perf = publicPerf.slice(publicPerf.indexOf('function public.get_provider_public_performance'), publicPerf.indexOf('function public.get_provider_public_trade_history'))
  assert.match(perf, /not coalesce\(v_src\.shared, false\)/)
  assert.match(perf, /return query select false/)
  const history = publicPerf.slice(publicPerf.indexOf('function public.get_provider_public_trade_history'), publicPerf.indexOf('revoke all on function public.provider_public_source_trades'))
  assert.match(history, /not coalesce\(v_src\.shared, false\)/)
  assert.match(history, /least\(coalesce\(p_limit, 100\), 250\)/)
  assert.doesNotMatch(publicPerf, /email|account_login|broker_account_id,\s*t\./)
})

const cashflow = read('_provider_cashflow_totals.sql')

test('deposit/withdrawal totals are server-written only and exposed through the share-gated public RPC', () => {
  assert.match(cashflow, /add column if not exists total_deposits numeric/)
  // Clients can update their own broker row, so a trigger must preserve the server-derived columns.
  assert.match(cashflow, /broker_accounts_protect_cashflow_totals/)
  assert.match(cashflow, /in \('authenticated', 'anon'\)/)
  assert.match(cashflow, /new\.total_deposits := old\.total_deposits/)
  assert.match(cashflow, /grant select \(total_deposits, total_withdrawals, cashflow_synced_at\) on public\.broker_accounts to authenticated/)
  assert.doesNotMatch(cashflow, /grant update/)
  // Public output sits behind the same share gate and falls back to the saved starting balance.
  assert.match(cashflow, /not coalesce\(v_src\.shared, false\)/)
  assert.match(cashflow, /coalesce\(v_cash\.total_deposits, v_cash\.performance_baseline_balance\)/)
  assert.match(cashflow, /grant execute on function public\.get_provider_public_performance\(text\) to anon, authenticated/)
})

test('every new broker_accounts column the app selects is readable by authenticated users', () => {
  // broker_accounts is read through column-level grants: one ungranted column in the client select
  // makes the whole accounts query fail and blanks the You page.
  const all = readdirSync(dir).filter(name => name.endsWith('.sql')).map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n')
  const select = readFileSync(new URL('./brokerAccountSelect.ts', import.meta.url), 'utf8')
  for (const column of ['account_leverage', 'total_deposits', 'total_withdrawals', 'cashflow_synced_at']) {
    assert.match(select, new RegExp(`'${column}'`), `${column} is in the client select`)
    assert.match(all, new RegExp(`grant select \\([^)]*\\b${column}\\b[^)]*\\) on public\\.broker_accounts to authenticated`), `${column} must be granted to authenticated`)
  }
})
