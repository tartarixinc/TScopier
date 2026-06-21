/** Google Analytics 4 measurement ID (gtag.js — not a GTM container). */
export const GA_MEASUREMENT_ID =
  (import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined)?.trim() || 'G-6TQBY0FKX3'

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: (...args: unknown[]) => void
  }
}

export function trackGaPageView(pagePath: string): void {
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return
  window.gtag('config', GA_MEASUREMENT_ID, { page_path: pagePath })
}

export function trackGaEvent(eventName: string, params: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') return
  window.gtag('event', eventName, params)
}
