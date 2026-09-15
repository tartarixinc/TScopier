export interface PlatformUpdate {
  id: string
  date: string
  title: string
  description: string
  type: 'feature' | 'fix' | 'improvement'
}

/**
 * Platform updates shown in the Updates modal and page.
 * Add new entries at the top — the modal shows the latest unseen update.
 */
export const PLATFORM_UPDATES: PlatformUpdate[] = [
  {
    id: 'symbol-mapping-whitelist-fix',
    date: '2026-09-15',
    title: 'Symbol mapping now works with whitelists',
    description:
      'When your broker uses a different symbol name (e.g. XAUUSD.X) than the channel signals (e.g. XAUUSD), the system now correctly translates symbols before checking your allowed symbols list. No manual configuration needed — just set your symbol mapping and it works.',
    type: 'fix',
  },
]

/** localStorage key for tracking which updates the user has seen. */
export const SEEN_UPDATES_KEY = 'tscopier_seen_updates'
