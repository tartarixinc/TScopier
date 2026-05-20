/** Errors from health checks that should not mark a broker disconnected. */
export function isTransientBrokerHealthError(message: string): boolean {
  return /unauthorized|not signed in|503|504|502|timeout|failed to fetch|network error|context deadline|gateway|load failed/i.test(
    message,
  )
}

/** Scale health poll interval with broker count to reduce MT API / DB load. */
export function brokerHealthPollIntervalMs(connectedCount: number, baseMs = 20_000): number {
  if (connectedCount <= 1) return baseMs
  return Math.min(baseMs * connectedCount, 90_000)
}
