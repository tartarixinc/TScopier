import { PlaceholderPage } from './PlaceholderPage'
import { useT } from '../../context/LocaleContext'

export function MarketNewsPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.marketNews.title} description={t.pages.marketNews.description} />
}
