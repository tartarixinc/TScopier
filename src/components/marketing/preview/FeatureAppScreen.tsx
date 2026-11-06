import type { ReactNode } from 'react'
import { useT } from '../../../context/LocaleContext'
import type { LandingFeatureVisualId } from '../../../i18n/locales/landing/types'
import { BacktestVisual } from '../features/visuals/BacktestVisual'
import { ChannelFiltersVisual } from '../features/visuals/ChannelFiltersVisual'
import { CopierLogsVisual } from '../features/visuals/CopierLogsVisual'
import { MultilingualSignalsVisual } from '../features/visuals/MultilingualSignalsVisual'
import { NewsCalendarVisual } from '../features/visuals/NewsCalendarVisual'
import { SignalEditVisual } from '../features/visuals/SignalEditVisual'
import { AppPreviewWindow, PreviewPageHeader } from './AppPreviewWindow'
import { SignalSourcePreview } from './SignalSourcePreview'

/** Lets the compact app panels fill the page width of the preview instead of staying phone-sized. */
const FILL_PAGE =
  '[&_.max-w-lg]:max-w-none [&_.max-w-md]:max-w-none [&>div]:min-h-0 [&>div]:items-start [&>div]:p-0!'

function Page({ route, title, children }: { route: string; title: string; children: ReactNode }) {
  return (
    <AppPreviewWindow activeRoute={route}>
      <PreviewPageHeader title={title} />
      <div className={FILL_PAGE}>{children}</div>
    </AppPreviewWindow>
  )
}

/** A real app screen (sidebar, header, page) for each platform feature. */
export function FeatureAppScreen({ id }: { id: LandingFeatureVisualId }) {
  const t = useT()

  switch (id) {
    case 'copier':
      return <SignalSourcePreview />
    case 'multilingual':
      return (
        <Page route="/manage-signals" title={t.nav.items.signalHistory}>
          <MultilingualSignalsVisual />
        </Page>
      )
    case 'filters':
      return (
        <Page route="/channels" title={t.channelsPage.title}>
          <ChannelFiltersVisual />
        </Page>
      )
    case 'signalEdit':
      return (
        <Page route="/manage-signals" title={t.nav.items.signalHistory}>
          <SignalEditVisual />
        </Page>
      )
    case 'backtest':
      return (
        <Page route="/backtest" title={t.nav.items.backtest}>
          <BacktestVisual />
        </Page>
      )
    case 'logs':
      return (
        <Page route="/copier-logs" title={t.nav.items.copierLogs}>
          <CopierLogsVisual />
        </Page>
      )
    case 'news':
      return (
        <Page route="/market-news" title={t.nav.items.marketNews}>
          <NewsCalendarVisual />
        </Page>
      )
    default:
      return null
  }
}
