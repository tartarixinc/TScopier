const COUNTRY_LOOKUP_URL = 'https://get.geojs.io/v1/ip/country.json'

export function countryCodeFromGeoPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const code = String((payload as { country?: unknown }).country ?? '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(code) ? code : null
}

export async function lookupCountryCodeFromIp(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(COUNTRY_LOOKUP_URL)
    if (!response.ok) return null
    return countryCodeFromGeoPayload(await response.json())
  } catch {
    return null
  }
}
