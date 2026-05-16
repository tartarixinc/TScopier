import { PlaceholderPage } from './PlaceholderPage'
import { useT } from '../../context/LocaleContext'

export function AnalysisHubPage() {
  const t = useT()
  return <PlaceholderPage title={t.pages.analysisHub.title} description={t.pages.analysisHub.description} />
}
