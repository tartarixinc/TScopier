import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { trackGaPageView } from '../../lib/googleAnalytics'

/** Sends GA4 page_view on SPA route changes (initial load is handled in index.html). */
export function GoogleAnalyticsRouteTracker() {
  const location = useLocation()
  const isFirstRender = useRef(true)

  useEffect(() => {
    const pagePath = `${location.pathname}${location.search}`
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    trackGaPageView(pagePath)
  }, [location.pathname, location.search])

  return null
}
