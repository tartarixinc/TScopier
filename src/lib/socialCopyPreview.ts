export type SocialCopyRiskMode = 'proportional' | 'fixed_lot' | 'risk_multiplier'

type SocialCopyLotInput = {
  mode: SocialCopyRiskMode
  traderLot: number
  traderBalance: number | null | undefined
  destinationBalance: number | null | undefined
  fixedLot: number
  multiplier: number
}

function validPositive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0
}

function roundLot(value: number): number {
  return Math.max(0.01, Math.round(value * 100) / 100)
}

/**
 * Frontend-only sizing illustration for the social-copy setup preview.
 * It deliberately does not calculate pip value, margin, or money at risk.
 */
export function estimateSocialCopyLot({
  mode,
  traderLot,
  traderBalance,
  destinationBalance,
  fixedLot,
  multiplier,
}: SocialCopyLotInput): number | null {
  if (!validPositive(traderLot)) return null
  if (mode === 'fixed_lot') {
    return validPositive(fixedLot) ? roundLot(fixedLot) : null
  }
  if (mode === 'risk_multiplier') {
    return validPositive(multiplier) ? roundLot(traderLot * multiplier) : null
  }
  if (!validPositive(traderBalance) || !validPositive(destinationBalance)) return null
  return roundLot(traderLot * (destinationBalance / traderBalance))
}
