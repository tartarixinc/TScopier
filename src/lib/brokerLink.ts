/** MetatraderAPI session id (UUID from ConnectEx). */
export function isMtSessionUuid(metaapiAccountId: string | null | undefined): boolean {
  const v = (metaapiAccountId ?? '').trim()
  if (!v || v.includes('|')) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

/** Pre–MetatraderAPI rows stored `ServerName|Login` in metaapi_account_id. */
export function isLegacyBrokerLink(metaapiAccountId: string | null | undefined): boolean {
  const v = (metaapiAccountId ?? '').trim()
  return v.length > 0 && v.includes('|')
}
