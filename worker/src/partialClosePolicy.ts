export type PartialClosePlan =
  | {
      ok: true
      closeVolume: number
      expectedRemainingVolume: number
      rawCloseVolume: number
    }
  | {
      ok: false
      reason:
        | 'partial_close_invalid_volume_constraints'
        | 'partial_close_unavailable_for_position_size'
        | 'partial_close_volume_above_broker_max'
      rawCloseVolume: number
    }

function positive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase()
  if (text.includes('e-')) return Math.min(12, Number(text.split('e-')[1]) || 0)
  return (text.split('.')[1] ?? '').length
}

function floorToStep(value: number, step: number): number {
  const places = Math.max(decimalPlaces(step), decimalPlaces(value))
  const scale = 10 ** Math.min(12, places)
  const stepUnits = Math.max(1, Math.round(step * scale))
  const valueUnits = Math.floor(value * scale + 1e-8)
  return Math.floor(valueUnits / stepUnits) * stepUnits / scale
}

/**
 * Normalize a requested partial reduction down to the broker step. The result
 * must itself be closable and must leave another broker-valid open position.
 */
export function planPartialClose(args: {
  currentVolume: number
  requestedFraction: number
  minVolume: number
  volumeStep: number
  maxVolume?: number | null
}): PartialClosePlan {
  const current = positive(args.currentVolume)
  const fraction = positive(args.requestedFraction)
  const min = positive(args.minVolume)
  const step = positive(args.volumeStep)
  const max = args.maxVolume == null ? null : positive(args.maxVolume)
  const raw = current != null && fraction != null ? current * fraction : Number.NaN
  if (current == null || fraction == null || fraction >= 1 || min == null || step == null) {
    return { ok: false, reason: 'partial_close_invalid_volume_constraints', rawCloseVolume: raw }
  }

  const closeVolume = floorToStep(raw, step)
  const expectedRemainingVolume = floorToStep(current - closeVolume, step)
  const epsilon = Math.max(1e-10, step / 10_000)
  if (
    closeVolume <= 0
    || closeVolume + epsilon < min
    || expectedRemainingVolume + epsilon < min
    || closeVolume >= current - epsilon
  ) {
    return { ok: false, reason: 'partial_close_unavailable_for_position_size', rawCloseVolume: raw }
  }
  if (max != null && closeVolume > max + epsilon) {
    return { ok: false, reason: 'partial_close_volume_above_broker_max', rawCloseVolume: raw }
  }
  return { ok: true, closeVolume, expectedRemainingVolume, rawCloseVolume: raw }
}

export function verifyPartialCloseReduction(args: {
  originalVolume: number
  requestedCloseVolume: number
  observedRemainingVolume: number
  volumeStep: number
}): { ok: true } | { ok: false; reason: string } {
  const original = positive(args.originalVolume)
  const requested = positive(args.requestedCloseVolume)
  const observed = positive(args.observedRemainingVolume)
  const step = positive(args.volumeStep)
  if (original == null || requested == null || observed == null || step == null) {
    return { ok: false, reason: 'partial close broker readback missing valid volume' }
  }
  if (!(observed > 0 && observed < original)) {
    return { ok: false, reason: 'partial close broker readback did not show a reduced open position' }
  }
  const actualReduction = original - observed
  const epsilon = Math.max(1e-8, step / 1000)
  if (Math.abs(actualReduction - requested) > epsilon) {
    return { ok: false, reason: 'partial close broker reduction differs from requested normalized volume' }
  }
  return { ok: true }
}
