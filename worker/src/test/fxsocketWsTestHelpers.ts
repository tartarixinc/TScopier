export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Collect connection open/close events without branching in tests. */
export function createConnectionEventCollector(): {
  events: boolean[]
  onConnectionChange: (connected: boolean) => void
  sawDisconnect: () => boolean
} {
  const events: boolean[] = []
  return {
    events,
    onConnectionChange: (connected: boolean) => {
      events.push(connected)
    },
    sawDisconnect: () => events.includes(false),
  }
}

export function sawExpectedWsHandshake(messages: string[]): boolean {
  return messages.includes('terminal') || messages.includes('subscribed')
}
