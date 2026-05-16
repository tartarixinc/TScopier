import { PlaceholderPage } from './PlaceholderPage'
import { useT } from '../../context/LocaleContext'

export function PortfolioPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.portfolio.title} description={t.pages.portfolio.description} />
}
