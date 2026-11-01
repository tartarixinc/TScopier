/** Minimal Web Storage for Vitest (node environment has no browser globals). */
function createStorageMock(): Storage {
  const store = new Map<string, string>()
  return {
    getItem(key: string) {
      return store.get(key) ?? null
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
    removeItem(key: string) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
    key(index: number) {
      return [...store.keys()][index] ?? null
    },
    get length() {
      return store.size
    },
  }
}

for (const name of ['sessionStorage', 'localStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    value: createStorageMock(),
    writable: true,
    configurable: true,
  })
}
