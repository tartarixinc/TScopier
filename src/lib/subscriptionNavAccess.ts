const EXACT_PATHS_WITHOUT_SUBSCRIPTION = new Set([
  '/channels',
  '/billing',
  '/affiliate-program',
  '/contact-support',
  '/pricing',
])

/** Routes reachable in the app shell when the user has no active subscription. */
export function isRouteAllowedWithoutSubscription(pathname: string): boolean {
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) return true
  return EXACT_PATHS_WITHOUT_SUBSCRIPTION.has(pathname)
}
