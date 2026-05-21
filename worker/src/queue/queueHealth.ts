/** Optional queue metrics hook for /health (trade workers). */

import type { QueueConsumerMetrics } from './signalQueueConsumer'

let metricsProvider: (() => Promise<QueueConsumerMetrics[]>) | null = null

export function setQueueMetricsProvider(
  provider: (() => Promise<QueueConsumerMetrics[]>) | null,
): void {
  metricsProvider = provider
}

export async function getQueueHealthMetrics(): Promise<QueueConsumerMetrics[]> {
  if (!metricsProvider) return []
  try {
    return await metricsProvider()
  } catch {
    return []
  }
}
