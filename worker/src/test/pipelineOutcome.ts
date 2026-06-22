import type { TradingPlatform } from './tradingPlatforms'
import type { LoadScenario } from './telegramPipelineFixtures'

/** Last stage successfully completed in the Telegram → broker pipeline. */
export type PipelineStage =
  | 'telegram_received'
  | 'heuristic_pass'
  | 'parsed'
  | 'eligible'
  | 'dispatched'
  | 'broker_order_send'

export const PIPELINE_STAGE_ORDER: PipelineStage[] = [
  'telegram_received',
  'heuristic_pass',
  'parsed',
  'eligible',
  'dispatched',
  'broker_order_send',
]

export type PipelineOutcome = {
  userId: string
  signalId: string
  platform: TradingPlatform
  scenario?: LoadScenario
  stageReached: PipelineStage
  skipReason?: string
  latencyMs: number | null
  brokerReached: boolean
}

export type UserDeliverySummary = {
  userId: string
  platform: TradingPlatform
  expectedSignals: number
  brokerDelivered: number
  allDelivered: boolean
}

export type HeavyLoadFunnel = Record<PipelineStage, number>

export type HeavyLoadReport = {
  config: {
    userCount: number
    minSignalsPerUser: number
    maxSignalsPerUser: number
    concurrency: number
    totalSignals: number
    profile: 'happy' | 'mixed' | 'unhappy'
  }
  funnel: HeavyLoadFunnel
  signalsFailed: number
  signalsExpectedOnBroker: number
  usersAllSignalsOnBroker: number
  usersPartialBroker: number
  usersNoBroker: number
  userDeliveryRate: number
  signalDeliveryRate: number
  byScenario: Record<LoadScenario, { signals: number; brokerReached: number }>
  failureReasons: Record<string, number>
  latencyMs: {
    min: number
    p50: number
    p95: number
    p99: number
    max: number
    avg: number
  }
  byPlatform: Record<
    TradingPlatform,
    { signals: number; brokerReached: number; users: number; usersAllDelivered: number }
  >
  wallMs: number
  throughputSignalsPerSec: number
}
