import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import MarketingApp from './MarketingApp.tsx'
import { applyThemeToDocument, readStoredTheme, ThemeProvider } from './context/ThemeContext.tsx'
import { isAppHost } from './lib/site.ts'

applyThemeToDocument(readStoredTheme())

function Root() {
  return isAppHost() ? <App /> : <MarketingApp />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  </StrictMode>,
)
