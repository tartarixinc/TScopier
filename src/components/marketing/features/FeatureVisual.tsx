import type { LandingFeatureVisualId } from '../../../i18n/locales/landing/types'
import { BacktestVisual } from './visuals/BacktestVisual'
import { ChannelFiltersVisual } from './visuals/ChannelFiltersVisual'
import { CopierFlowVisual } from './visuals/CopierFlowVisual'
import { CopierLogsVisual } from './visuals/CopierLogsVisual'
import { IntegrationsVisual } from './visuals/IntegrationsVisual'
import { NewsCalendarVisual } from './visuals/NewsCalendarVisual'

interface FeatureVisualProps {
  id: LandingFeatureVisualId
}

export function FeatureVisual({ id }: FeatureVisualProps) {
  switch (id) {
    case 'copier':
      return <CopierFlowVisual />
    case 'filters':
      return <ChannelFiltersVisual />
    case 'backtest':
      return <BacktestVisual />
    case 'logs':
      return <CopierLogsVisual />
    case 'news':
      return <NewsCalendarVisual />
    case 'integrations':
      return <IntegrationsVisual />
    default:
      return null
  }
}
