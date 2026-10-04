/**
 * Demo-only outage trigger so the degraded-mode experience can be shown on
 * demand instead of waiting for a real vendor outage:
 *
 *   https://app.tscopier.ai/trades?demo=broker-down
 *
 * With the flag set, live broker reads fail exactly as they would during an
 * outage, which drives the read-side database fallback and the degraded
 * banner; removing the parameter (or the query) restores normal reads, and
 * the banner then clears itself on the next successful poll.
 *
 * It only ever *fails a read* — it never fabricates trades, and it is inert
 * unless the parameter is explicitly present in the URL.
 */
export function isBrokerDownDemo(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
): boolean {
  try {
    return new URLSearchParams(search).get('demo') === 'broker-down'
  } catch {
    return false
  }
}
