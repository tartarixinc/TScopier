import { lazy, Suspense, useEffect, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { PageLoader } from './PageLoader'
import { useNeedsWelcome } from '../../hooks/useNeedsWelcome'

const DashboardPage = lazy(() =>
  import('../../pages/dashboard/DashboardPage').then(m => ({ default: m.DashboardPage })),
)
const BrokerStatsOverlay = lazy(() =>
  import('../../pages/dashboard/BrokerStatsOverlay').then(m => ({ default: m.BrokerStatsOverlay })),
)

/** Keep Dashboard mounted after first visit so stats/charts do not reset on navigation. */
export function DashboardKeepAlive() {
  const location = useLocation()
  const { deferAppBootstrap, needsWelcome } = useNeedsWelcome()
  const onDashboard = location.pathname === '/dashboard'
    || location.pathname.startsWith('/dashboard/broker/')
  const [mounted, setMounted] = useState(onDashboard || needsWelcome)

  useEffect(() => {
    if (onDashboard || needsWelcome) setMounted(true)
  }, [onDashboard, needsWelcome])

  if (deferAppBootstrap || !mounted) return null

  return (
    <div className={onDashboard ? 'min-h-full' : 'hidden'} aria-hidden={!onDashboard}>
      <Suspense fallback={onDashboard ? <PageLoader /> : null}>
        <Routes>
          <Route path="/dashboard/*" element={<DashboardPage />}>
            <Route path="broker/:brokerId" element={<BrokerStatsOverlay />} />
          </Route>
        </Routes>
      </Suspense>
    </div>
  )
}
