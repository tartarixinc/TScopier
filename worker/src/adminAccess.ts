export type AdminProfileFields = {
  is_admin?: boolean | null
  admin_until?: string | null
}

/** True when DB admin bypass is active (respects timed expiry). */
export function isAdminAccessActive(
  profile: AdminProfileFields | null | undefined,
): boolean {
  if (profile?.is_admin !== true) return false
  const until = profile.admin_until
  if (until == null || until === '') return true
  return new Date(until).getTime() > Date.now()
}
