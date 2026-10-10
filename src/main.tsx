import { StrictMode, lazy, Suspense, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { applyThemeToDocument, readStoredTheme, ThemeProvider } from './context/ThemeContext.tsx'
import { isAppHost } from './lib/site.ts'
import { DashboardBootSkeleton, isDashboardBootPath } from './components/dashboard/DashboardMetricsSkeleton.tsx'
import { clearChunkReloadGuard, registerChunkLoadRecovery } from './lib/chunkLoadRecovery.ts'

registerChunkLoadRecovery()

applyThemeToDocument(readStoredTheme())

const App = lazy(() => import('./App.tsx'))
const MarketingApp = lazy(() => import('./MarketingApp.tsx'))

const RootComponent = isAppHost() ? App : MarketingApp

function BootGuardClear() {
  useEffect(() => {
    clearChunkReloadGuard()
  }, [])
  return null
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <BootGuardClear />
      <Suspense
        fallback={
          isAppHost() && isDashboardBootPath(window.location.pathname) ? (
            <div className="flex h-[100dvh] min-h-0">
              <DashboardBootSkeleton />
            </div>
          ) : (
            <div className="flex min-h-screen items-center justify-center">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
            </div>
          )
        }
      >
        <RootComponent />
      </Suspense>
    </ThemeProvider>
  </StrictMode>,
)
