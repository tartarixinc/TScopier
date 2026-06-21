import { StrictMode, lazy, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { applyThemeToDocument, readStoredTheme, ThemeProvider } from './context/ThemeContext.tsx'
import { isAppHost } from './lib/site.ts'
import { clearChunkReloadGuard, registerChunkLoadRecovery } from './lib/chunkLoadRecovery.ts'

registerChunkLoadRecovery()

applyThemeToDocument(readStoredTheme())

const App = lazy(() => import('./App.tsx'))
const MarketingApp = lazy(() => import('./MarketingApp.tsx'))

function BootGuardClear() {
  useEffect(() => {
    clearChunkReloadGuard()
  }, [])
  return null
}

function Root() {
  const [showApp, setShowApp] = useState(() => isAppHost())

  useEffect(() => {
    const sync = () => setShowApp(isAppHost())
    sync()
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])

  const Component = showApp ? App : MarketingApp

  return (
    <>
      <BootGuardClear />
      <Suspense
        fallback={
          <div className="flex min-h-screen items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
          </div>
        }
      >
        <Component />
      </Suspense>
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </StrictMode>,
)
