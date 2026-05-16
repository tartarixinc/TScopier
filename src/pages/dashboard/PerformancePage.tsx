import { PlaceholderPage } from './PlaceholderPage'
import { useT } from '../../context/LocaleContext'

export function PerformancePage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.performance.title} description={t.pages.performance.description} />
}
