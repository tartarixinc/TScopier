import { supabase } from './supabase'

export const PROFILE_PHOTO_BUCKET = 'profile-photos'
export const PROFILE_PHOTO_MAX_BYTES = 2 * 1024 * 1024
export const PROFILE_PHOTO_SOURCE_MAX_BYTES = 12 * 1024 * 1024
export const PROFILE_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export type ProfilePhotoRejection = 'type' | 'size'

export function profilePhotoObjectPath(userId: string): string {
  return `${userId}/avatar`
}

export function validateProfilePhoto(file: { type: string; size: number }): ProfilePhotoRejection | null {
  if (!PROFILE_PHOTO_MIME_TYPES.includes(file.type as (typeof PROFILE_PHOTO_MIME_TYPES)[number])) return 'type'
  if (file.size <= 0 || file.size > PROFILE_PHOTO_MAX_BYTES) return 'size'
  return null
}

export function validateProfilePhotoSource(file: { type: string; size: number }): ProfilePhotoRejection | null {
  if (!PROFILE_PHOTO_MIME_TYPES.includes(file.type as (typeof PROFILE_PHOTO_MIME_TYPES)[number])) return 'type'
  if (file.size <= 0 || file.size > PROFILE_PHOTO_SOURCE_MAX_BYTES) return 'size'
  return null
}

export async function uploadProfilePhoto(userId: string, file: File): Promise<string> {
  const rejection = validateProfilePhoto(file)
  if (rejection === 'type') throw new Error('invalid_type')
  if (rejection === 'size') throw new Error('too_large')

  const path = profilePhotoObjectPath(userId)
  const { error: uploadError } = await supabase.storage
    .from(PROFILE_PHOTO_BUCKET)
    .upload(path, file, {
      upsert: true,
      contentType: file.type,
      cacheControl: '3600',
    })
  if (uploadError) throw new Error(uploadError.message)

  const { data } = supabase.storage.from(PROFILE_PHOTO_BUCKET).getPublicUrl(path)
  const avatarUrl = `${data.publicUrl}?v=${Date.now()}`
  const { error: saveError } = await supabase
    .from('user_profiles')
    .upsert({ user_id: userId, avatar_url: avatarUrl }, { onConflict: 'user_id' })
  if (saveError) throw new Error(saveError.message)
  return avatarUrl
}
