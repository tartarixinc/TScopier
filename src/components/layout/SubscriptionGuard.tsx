import { useLocation } from 'react-router-dom'
import { useSubscription } from '../../context/SubscriptionContext'
import { DashboardBootSkeleton, isDashboardBootPath } from '../dashboard/DashboardMetricsSkeleton'

export function SubscriptionGuard({ children }: { children: React.ReactNode }) {
  const { loading } = useSubscription()
  const location = useLocation()

  if (loading) {
    if (isDashboardBootPath(location.pathname)) return <DashboardBootSkeleton />
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-teal-600 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return <>{children}</>
}
