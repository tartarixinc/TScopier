import type { LoadScenario } from './telegramPipelineFixtures'
import { scenarioForProfile } from './telegramPipelineFixtures'

const REQUIRED_MIXED_SCENARIOS: LoadScenario[] = [
  'happy',
  'heuristic_reject',
  'broker_session_down',
  'broker_ws_down',
]

/** Whether a mixed-profile sample includes every failure class we inject. */
export function mixedProfileCoversRequiredScenarios(sampleSize = 200): boolean {
  const seen = new Set(
    Array.from({ length: sampleSize }, (_, index) => scenarioForProfile(index, 'mixed')),
  )
  return REQUIRED_MIXED_SCENARIOS.every(scenario => seen.has(scenario))
}
