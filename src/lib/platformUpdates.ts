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

/**
 * In-memory mirror of the seen list. Keeps the announcement from re-showing
 * in the current tab even when localStorage is unavailable or throws
 * (private mode, blocked storage, quota exceeded).
 */
const memorySeenUpdateIds = new Set<string>()

/** Read the ids the user has already seen. Never throws. */
export function readSeenUpdateIds(): Set<string> {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(SEEN_UPDATES_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            if (typeof id === 'string') memorySeenUpdateIds.add(id)
          }
        }
      }
    }
  } catch {
    // Ignore malformed JSON or unavailable storage; fall back to memory.
  }
  return new Set(memorySeenUpdateIds)
}

/** Mark ids as seen. Never throws, so dismissal always sticks. */
export function markUpdateIdsSeen(ids: string[]): void {
  for (const id of ids) memorySeenUpdateIds.add(id)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SEEN_UPDATES_KEY, JSON.stringify([...memorySeenUpdateIds]))
    }
  } catch {
    // Ignore unavailable storage; the in-memory set still suppresses a re-show.
  }
}

/** The latest update the user has not seen yet, or null when all are seen. */
export function latestUnseenUpdate(
  updates: PlatformUpdate[] = PLATFORM_UPDATES,
  seen: Set<string> = readSeenUpdateIds(),
): PlatformUpdate | null {
  return updates.find(u => !seen.has(u.id)) ?? null
}

/** Ids of every update currently listed. */
export function allPlatformUpdateIds(updates: PlatformUpdate[] = PLATFORM_UPDATES): string[] {
  return updates.map(u => u.id)
}
