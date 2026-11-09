import type { ReactNode } from 'react'
import { SupportChatProvider } from '../../context/SupportChatContext'
import { MarketingHeader } from './MarketingHeader'
import { MarketingFooter } from './MarketingFooter'
import { MarketingPromoBanner } from './MarketingPromoBanner'
import { MarketingPromoOffsetProvider } from './MarketingPromoOffset'

interface MarketingLayoutProps {
  children: ReactNode
  /** The first section is a dark full-bleed hero running under the nav. */
  darkHero?: boolean
}

export function MarketingLayout({ children, darkHero }: MarketingLayoutProps) {
  return (
    <SupportChatProvider>
      <div className="marketing-hero-bg marketing-page-bg relative flex min-h-screen flex-col">
        <div className="trustpilot-panel-radial pointer-events-none absolute inset-0 hidden dark:block" aria-hidden />
        <MarketingPromoOffsetProvider>
          <MarketingPromoBanner />
          <MarketingHeader overDarkHero={darkHero} />
        </MarketingPromoOffsetProvider>

        <main className="relative z-10 flex-1 pt-16">{children}</main>

        <MarketingFooter />
      </div>
    </SupportChatProvider>
  )
}
