import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertOwnedAuthUser,
  assertSafePublicationState,
  executePublicationLifecycle,
  projectRefFromUrl as seedProjectRefFromUrl,
} from './seed-social-trading-personal.mjs'
import { projectRefFromUrl as verifyProjectRefFromUrl } from './verify-social-trading-personal.mjs'

const PROJECT_REF = 'abcdefghijklmnopqrst'
const PROVIDER_ID = '10000000-0000-5000-8000-000000000001'
const BROKER_ID = '20000000-0000-5000-8000-000000000002'
const SOURCE_ID = '30000000-0000-5000-8000-000000000003'
const SOURCE_LABEL = '[tscopier-personal-social-v1] Verified Demo Source'
const expected = { providerUserId: PROVIDER_ID, brokerAccountId: BROKER_ID, sourceId: SOURCE_ID }

function markers(role = 'provider') {
  return {
    tscopier_seed_id: 'tscopier-personal-social-v1',
    tscopier_seed_project_ref: PROJECT_REF,
    tscopier_seed_role: role,
  }
}

function source(status = 'paused') {
  return {
    id: SOURCE_ID,
    trader_user_id: PROVIDER_ID,
    broker_account_id: BROKER_ID,
    status,
    label: SOURCE_LABEL,
  }
}

test('Auth ownership requires matching immutable and user metadata markers', () => {
  const owned = { app_metadata: markers(), user_metadata: markers() }
  assert.doesNotThrow(() => assertOwnedAuthUser(owned, PROJECT_REF, 'provider', 'provider@example.test'))
  assert.throws(
    () => assertOwnedAuthUser({ ...owned, app_metadata: {} }, PROJECT_REF, 'provider', 'provider@example.test'),
    /without the expected seed ownership metadata/,
  )
  assert.throws(
    () => assertOwnedAuthUser({ ...owned, user_metadata: markers('viewer') }, PROJECT_REF, 'provider', 'provider@example.test'),
    /without the expected seed ownership metadata/,
  )
})

test('seed and verifier accept only an exact HTTPS Supabase project origin', () => {
  for (const parse of [seedProjectRefFromUrl, verifyProjectRefFromUrl]) {
    assert.equal(parse(`https://${PROJECT_REF}.supabase.co`), PROJECT_REF)
    assert.equal(parse(`https://${PROJECT_REF}.supabase.co/`), PROJECT_REF)
    for (const invalid of [
      `http://${PROJECT_REF}.supabase.co`,
      `https://user:pass@${PROJECT_REF}.supabase.co`,
      `https://${PROJECT_REF}.supabase.co:444`,
      `https://${PROJECT_REF}.supabase.co:443`,
      `https://${PROJECT_REF}.supabase.co/rest`,
      `https://${PROJECT_REF}.supabase.co//`,
      `https://${PROJECT_REF}.supabase.co/.`,
      `https://${PROJECT_REF}.supabase.co?target=other`,
      `https://${PROJECT_REF}.supabase.co#other`,
      `https://${PROJECT_REF}.supabase.co.evil.example`,
    ]) {
      assert.throws(() => parse(invalid))
    }
  }
})

test('unrelated subscription aborts before source staging or publication', async () => {
  let staged = false
  let published = false
  const unsafeState = {
    sources: [source()],
    subscriptions: [{ id: 'unrelated-subscription' }],
  }
  await assert.rejects(
    executePublicationLifecycle({
      loadState: async () => unsafeState,
      validateState: (state, options) => assertSafePublicationState(state, expected, options),
      stageSource: async () => { staged = true },
      publishSource: async () => { published = true },
    }),
    /subscriptions exist/,
  )
  assert.equal(staged, false)
  assert.equal(published, false)
})

test('publication lifecycle stages deterministic paused source before actor RPC', async () => {
  const events = []
  let state = { sources: [], subscriptions: [] }
  await executePublicationLifecycle({
    loadState: async () => structuredClone(state),
    validateState: (nextState, options) => assertSafePublicationState(nextState, expected, options),
    stageSource: async () => {
      events.push('stage')
      state = { sources: [source('paused')], subscriptions: [] }
    },
    publishSource: async () => {
      events.push('publish')
      state = { sources: [source('published')], subscriptions: [] }
    },
  })
  assert.deepEqual(events, ['stage', 'publish'])
})

test('rerun skips side-effecting publication RPC for exact published source', async () => {
  let staged = false
  let published = false
  const state = { sources: [source('published')], subscriptions: [] }
  await executePublicationLifecycle({
    loadState: async () => state,
    validateState: (nextState, options) => assertSafePublicationState(nextState, expected, options),
    stageSource: async () => { staged = true },
    publishSource: async () => { published = true },
  })
  assert.equal(staged, false)
  assert.equal(published, false)
})


test('post-publication assertion rejects a subscription introduced during publication', async () => {
  let state = { sources: [source('paused')], subscriptions: [] }
  await assert.rejects(
    executePublicationLifecycle({
      loadState: async () => structuredClone(state),
      validateState: (nextState, options) => assertSafePublicationState(nextState, expected, options),
      stageSource: async () => { throw new Error('source is already staged') },
      publishSource: async () => {
        state = {
          sources: [source('published')],
          subscriptions: [{ id: 'forbidden-subscription' }],
        }
      },
    }),
    /subscriptions exist/,
  )
})
test('source collision fails closed', () => {
  assert.throws(
    () => assertSafePublicationState({
      sources: [{ ...source(), id: 'unrelated-source' }],
      subscriptions: [],
    }, expected),
    /not the exact seed-owned deterministic source/,
  )
})
