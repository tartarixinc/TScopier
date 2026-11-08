import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchSocialTraderReviews, saveSocialTraderReview, validateSocialReview } from './socialReviews'

test('validates rating and written review before making a request', async () => {
  assert.match(validateSocialReview(0, 'Useful review') ?? '', /1 to 5/)
  assert.match(validateSocialReview(5, '   ') ?? '', /Write a review/)
  assert.equal(validateSocialReview(5, 'Reliable risk management.'), null)
  const client = { rpc: async () => { throw new Error('must not call') } } as unknown as SupabaseClient
  await assert.rejects(saveSocialTraderReview(client, { traderUserId: 'trader', rating: 6, reviewText: 'bad' }), /1 to 5/)
})

test('submits an upsert so an existing review is edited rather than duplicated', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = { rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args }); return { data: 'review-id', error: null }
  } } as unknown as SupabaseClient
  assert.equal(await saveSocialTraderReview(client, { traderUserId: 'trader', rating: 4, reviewText: '  Clear updates.  ' }), 'review-id')
  assert.deepEqual(calls, [{ name: 'upsert_social_trader_review', args: {
    p_trader_user_id: 'trader', p_rating: 4, p_review_text: 'Clear updates.',
  } }])
})

test('maps persisted reviews and privacy-safe reviewer identity', async () => {
  const client = { rpc: async () => ({ data: [{
    review_id: 'review', rating: 5, review_text: 'Excellent', reviewer_display_name: null,
    reviewer_username: null, is_own: false, created_at: '2026-10-15T00:00:00Z', updated_at: '2026-10-15T00:00:00Z',
  }], error: null }) } as unknown as SupabaseClient
  assert.deepEqual(await fetchSocialTraderReviews(client, 'trader'), [{
    reviewId: 'review', rating: 5, reviewText: 'Excellent', reviewerDisplayName: null,
    reviewerUsername: null, isOwn: false, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z',
  }])
})

test('surfaces database self-review and authorization failures', async () => {
  const client = { rpc: async () => ({ data: null, error: { message: 'Users cannot review themselves' } }) } as unknown as SupabaseClient
  await assert.rejects(saveSocialTraderReview(client, { traderUserId: 'self', rating: 3, reviewText: 'Self review' }), /cannot review themselves/)
})
