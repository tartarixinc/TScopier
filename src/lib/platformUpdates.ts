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
    id: 'explain-with-ai-copier-logs',
    date: '2026-09-15',
    title: 'Explain with AI is now in Copier Logs',
    description:
      'Click "Explain with AI" on any trade in Copier Logs to get an instant AI analysis of what happened — why the trade was opened, what the outcome was, and any issues encountered. No need to leave the page or copy-paste details.',
    type: 'feature',
  },
  {
    id: 'platform-updates-page',
    date: '2026-09-15',
    title: 'Platform Updates page',
    description:
      'You can now see what changed in TScopier without leaving the app. Check the Updates section in the sidebar for recent features, fixes, and improvements.',
    type: 'feature',
  },
]

/** localStorage key for tracking which updates the user has seen. */
export const SEEN_UPDATES_KEY = 'tscopier_seen_updates'
