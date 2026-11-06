import type { SupabaseClient } from '@supabase/supabase-js'

export const SOCIAL_REVIEW_MAX_LENGTH = 2000

export type SocialTraderReview = {
  reviewId: string
  rating: number
  reviewText: string
  reviewerDisplayName: string | null
  reviewerUsername: string | null
  isOwn: boolean
  createdAt: string
  updatedAt: string
}

type ReviewRow = {
  review_id: string
  rating: number | string
  review_text: string
  reviewer_display_name: string | null
  reviewer_username: string | null
  is_own: boolean
  created_at: string
  updated_at: string
}

function requestError(error: unknown): Error {
  const message = error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : 'Trader review request failed'
  return new Error(message, { cause: error })
}

export function validateSocialReview(rating: number, reviewText: string): string | null {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return 'Choose a rating from 1 to 5 stars.'
  const length = reviewText.trim().length
  if (length < 1) return 'Write a review before submitting.'
  if (length > SOCIAL_REVIEW_MAX_LENGTH) return `Keep your review under ${SOCIAL_REVIEW_MAX_LENGTH} characters.`
  return null
}

export async function fetchSocialTraderReviews(client: SupabaseClient, traderUserId: string): Promise<SocialTraderReview[]> {
  const { data, error } = await client.rpc('get_social_trader_reviews', { p_trader_user_id: traderUserId })
  if (error) throw requestError(error)
  return ((data ?? []) as ReviewRow[]).map(row => ({
    reviewId: row.review_id,
    rating: Number(row.rating),
    reviewText: row.review_text,
    reviewerDisplayName: row.reviewer_display_name,
    reviewerUsername: row.reviewer_username,
    isOwn: row.is_own,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export async function saveSocialTraderReview(client: SupabaseClient, input: {
  traderUserId: string
  rating: number
  reviewText: string
}): Promise<string> {
  const validation = validateSocialReview(input.rating, input.reviewText)
  if (validation) throw new Error(validation)
  const { data, error } = await client.rpc('upsert_social_trader_review', {
    p_trader_user_id: input.traderUserId,
    p_rating: input.rating,
    p_review_text: input.reviewText.trim(),
  })
  if (error) throw requestError(error)
  return String(data)
}

export async function removeSocialTraderReview(client: SupabaseClient, traderUserId: string): Promise<void> {
  const { error } = await client.rpc('delete_social_trader_review', { p_trader_user_id: traderUserId })
  if (error) throw requestError(error)
}
