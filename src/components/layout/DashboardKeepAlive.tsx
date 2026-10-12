import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Route, Routes, useLocation, type Location } from 'react-router-dom'
import { DashboardRouteSkeleton } from '../dashboard/DashboardMetricsSkeleton'
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
  const { deferAppBootstrap } = useNeedsWelcome()
  const onDashboard = location.pathname === '/dashboard'
    || location.pathname.startsWith('/dashboard/broker/')
  const [mounted, setMounted] = useState(onDashboard)
  const dashboardLocationRef = useRef<Location | null>(onDashboard ? location : null)
  if (onDashboard) dashboardLocationRef.current = location

  useEffect(() => {
    if (onDashboard) setMounted(true)
  }, [onDashboard])

  if (deferAppBootstrap || !mounted) return null

  // Keep matching /dashboard after the user leaves so DashboardPage stays
  // mounted. A live <Routes> match unmounts it, and the next visit reloads.
  const routeLocation = onDashboard ? location : dashboardLocationRef.current ?? location

  return (
    <div className={onDashboard ? 'min-h-full' : 'hidden'} aria-hidden={!onDashboard}>
      <Suspense fallback={onDashboard ? <DashboardRouteSkeleton /> : null}>
        <Routes location={routeLocation}>
          <Route path="/dashboard/*" element={<DashboardPage />}>
            <Route path="broker/:brokerId" element={<BrokerStatsOverlay />} />
          </Route>
        </Routes>
      </Suspense>
    </div>
  )
}
