import assert from 'node:assert/strict'
import test from 'node:test'

type Profile = { is_admin?: boolean; admin_until?: string | null } | null
type Metadata = Record<string, unknown>

function fakeSupabase(profile: Profile, metadata: Metadata = {}) {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: profile, error: null }),
  }
  return {
    from: () => query,
    auth: { admin: { getUserById: async () => ({ data: { user: { app_metadata: metadata } }, error: null }) } },
  }
}

async function loadAdmin(profile: Profile, metadata: Metadata = {}, envIds = '') {
  ;(globalThis as typeof globalThis & { Deno: unknown }).Deno = {
    env: { get: (key: string) => key === 'TSCOPIER_ADMIN_USER_IDS' ? envIds : '' },
  }
  const { loadUserIsAdmin } = await import('./subscriptionAccess.ts')
  return loadUserIsAdmin(fakeSupabase(profile, metadata) as never, 'admin-user')
}

test('admin access sources include permanent and active timed DB admins', async () => {
  assert.equal(await loadAdmin({ is_admin: true, admin_until: null }), true)
  assert.equal(await loadAdmin({ is_admin: true, admin_until: new Date(Date.now() + 60_000).toISOString() }), true)
})

test('expired timed DB admin follows normal access rules', async () => {
  assert.equal(await loadAdmin({ is_admin: true, admin_until: new Date(Date.now() - 60_000).toISOString() }), false)
})

test('admin environment IDs and Auth metadata are admin access sources', async () => {
  assert.equal(await loadAdmin(null, {}, 'admin-user'), true)
  assert.equal(await loadAdmin(null, { is_admin: true }), true)
  assert.equal(await loadAdmin(null, { role: 'admin' }), true)
})
