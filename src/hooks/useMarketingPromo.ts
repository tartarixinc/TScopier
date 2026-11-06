import { useCallback, useEffect, useState } from 'react'
import { fetchMarketingPromo, promoRevision, type MarketingPromo } from '../lib/marketingPromo'

const REFRESH_MS = 5 * 60_000
const DISMISSED_KEY = 'tscopier:promo:dismissed'

// Shared by every page that mounts the banner, so moving between marketing pages does not flash or refetch.
let cache: { at: number; promo: MarketingPromo | null } | null = null
let pending: Promise<MarketingPromo | null> | null = null

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

async function load(force: boolean): Promise<MarketingPromo | null> {
  if (!force && cache && Date.now() - cache.at < REFRESH_MS) return cache.promo
  pending ??= fetchMarketingPromo()
    .then(promo => {
      cache = { at: Date.now(), promo }
      return promo
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** The live promo campaign (null while loading, when none is live, or once the visitor dismissed it). */
export function useMarketingPromo(): { promo: MarketingPromo | null; dismiss: () => void } {
  const [promo, setPromo] = useState<MarketingPromo | null>(() => cache?.promo ?? null)
  const [dismissedRevision, setDismissedRevision] = useState<string | null>(readDismissed)

  useEffect(() => {
    let cancelled = false
    const refresh = (force: boolean) => {
      void load(force).then(next => {
        if (!cancelled) setPromo(next)
      })
    }
    refresh(false)
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh(true)
    }, REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(false)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const revision = promo ? promoRevision(promo) : null

  const dismiss = useCallback(() => {
    if (!revision) return
    try {
      localStorage.setItem(DISMISSED_KEY, revision)
    } catch {
      /* the in-memory dismissal still hides it for this visit */
    }
    setDismissedRevision(revision)
  }, [revision])

  const hidden = promo != null && promo.dismissible && dismissedRevision === revision
  return { promo: hidden ? null : promo, dismiss }
}
