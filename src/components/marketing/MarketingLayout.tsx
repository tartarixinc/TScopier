import type { ReactNode } from 'react'
import { MarketingHeader } from './MarketingHeader'
import { MarketingFooter } from './MarketingFooter'

interface MarketingLayoutProps {
  children: ReactNode
}

export function MarketingLayout({ children }: MarketingLayoutProps) {
  return (
    <div className="marketing-hero-bg trustpilot-panel-bg trustpilot-panel-surface relative flex min-h-screen flex-col">
      <div className="trustpilot-panel-radial pointer-events-none absolute inset-0" aria-hidden />
      <MarketingHeader />

      <main className="relative z-10 flex-1 pt-[4.75rem] sm:pt-20">{children}</main>

      <MarketingFooter />
    </div>
  )
}
