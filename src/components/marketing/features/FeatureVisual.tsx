import type { LandingFeatureVisualId } from '../../../i18n/locales/landing/types'
import { BacktestVisual } from './visuals/BacktestVisual'
import { ChannelFiltersVisual } from './visuals/ChannelFiltersVisual'
import { CopierFlowVisual } from './visuals/CopierFlowVisual'
import { CopierLogsVisual } from './visuals/CopierLogsVisual'
import { MultilingualSignalsVisual } from './visuals/MultilingualSignalsVisual'
import { NewsCalendarVisual } from './visuals/NewsCalendarVisual'
import { SignalEditVisual } from './visuals/SignalEditVisual'

interface FeatureVisualProps {
  id: LandingFeatureVisualId
}

export function FeatureVisual({ id }: FeatureVisualProps) {
  switch (id) {
    case 'copier':
      return <CopierFlowVisual />
    case 'multilingual':
      return <MultilingualSignalsVisual />
    case 'filters':
      return <ChannelFiltersVisual />
    case 'signalEdit':
      return <SignalEditVisual />
    case 'backtest':
      return <BacktestVisual />
    case 'logs':
      return <CopierLogsVisual />
    case 'news':
      return <NewsCalendarVisual />
    default:
      return null
  }
}
