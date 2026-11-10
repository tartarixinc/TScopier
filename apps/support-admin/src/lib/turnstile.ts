export function turnstileSiteKey(): string {
  return String(import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '').trim()
}

export function isTurnstileEnabled(): boolean {
  return turnstileSiteKey().length > 0
}

/** True when a production build is missing the required public site key. */
export function isTurnstileMisconfigured(): boolean {
  return Boolean(import.meta.env.PROD) && !isTurnstileEnabled()
}
