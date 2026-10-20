import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

/** Reset the scroll position when navigating between marketing pages (hash links handle their own scroll). */
export function ScrollToTop() {
  const { pathname, hash } = useLocation()

  useEffect(() => {
    if (hash) return
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [pathname, hash])

  return null
}
