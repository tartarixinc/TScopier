export type DiscordReadyWatchdogAction = 'reset' | 'wait' | 'exit'

/**
 * Decides what the gateway watchdog should do on one tick. A healthy client
 * resets the clock; an unhealthy one is tolerated until it has been down for
 * `timeoutMs`, after which the process should exit so Railway restarts it.
 */
export function discordReadyWatchdogAction(input: {
  isReady: boolean
  lastReadyAt: number
  now: number
  timeoutMs: number
}): DiscordReadyWatchdogAction {
  if (input.isReady) return 'reset'
  return input.now - input.lastReadyAt >= input.timeoutMs ? 'exit' : 'wait'
}
