import type { ReactNode } from 'react'
import { AppAnnouncementProvider } from './AppAnnouncementContext'
import { AppBannerProvider } from './AppBannerContext'

/** Loads warning + announcement bar state for the authenticated app. */
export function AppTopBannersProvider({ children }: { children: ReactNode }) {
  return (
    <AppBannerProvider>
      <AppAnnouncementProvider>
        {children}
      </AppAnnouncementProvider>
    </AppBannerProvider>
  )
}
