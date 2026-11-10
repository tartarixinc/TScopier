import { isAdminAccessActive, type AdminProfileFields } from './adminAccess'

export type SupportProfileFields = AdminProfileFields & {
  is_support_agent?: boolean
}

export function isSupportAccessActive(
  profile: SupportProfileFields | null | undefined,
): boolean {
  if (profile?.is_support_agent === true) return true
  return isAdminAccessActive(profile)
}
