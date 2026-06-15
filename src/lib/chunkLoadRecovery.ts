const CHUNK_RELOAD_KEY = 'tscopier:chunk-reload'

function isChunkLoadFailure(reason: unknown): boolean {
  const msg = reason instanceof Error
    ? reason.message
    : typeof reason === 'string'
      ? reason
      : ''
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|expected a javascript-or-wasm module script/i.test(msg)
}

/** Reload once after deploy when cached index.html references removed Vite chunks. */
export function registerChunkLoadRecovery(): void {
  if (typeof window === 'undefined') return

  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault()
    reloadOnceForNewBuild()
  })

  window.addEventListener('unhandledrejection', (event) => {
    if (!isChunkLoadFailure(event.reason)) return
    event.preventDefault()
    reloadOnceForNewBuild()
  })
}

function reloadOnceForNewBuild(): void {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1') return
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
  } catch {
    // sessionStorage blocked — still try one reload
  }
  window.location.reload()
}

/** Call after a successful boot so a later deploy can trigger one more auto-reload. */
export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY)
  } catch {
    // ignore
  }
}
