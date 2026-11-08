import type { CopyRiskTranslations } from '../i18n/locales/copyRiskLabels'
import type { MirrorTradingPageTranslations, SocialTradingPageTranslations } from '../i18n/locales/types'

type SetupCopy = MirrorTradingPageTranslations['setup']
type SocialCopySetup = SocialTradingPageTranslations['copySetup']

/** Social UI says "provider"; Mirror keeps "source". */
function sourceNounToProvider(text: string): string {
  let next = text
    .replace(/\bde origen\b/gi, 'del proveedor')
    .replace(/\bel origen\b/gi, 'el proveedor')
    .replace(/\borigen\b/gi, 'proveedor')
  if (!/\bsource\b/i.test(next)) return next
  const french = /[àâéèêëïôùûçœ’']|Clôturer|Copier le|Âge max/i.test(next)
  if (french) {
    return next
      .replace(/\bla source\b/gi, 'le fournisseur')
      .replace(/\bSource\b/g, 'Fournisseur')
      .replace(/\bsource\b/g, 'fournisseur')
  }
  return next
    .replace(/\bSource\b/g, 'Provider')
    .replace(/\bsource\b/g, 'provider')
}

/** Remap Mirror copy-risk labels so Social config says provider instead of source. */
export function copyRiskLabelsForSocial(labels: CopyRiskTranslations): CopyRiskTranslations {
  return {
    ...labels,
    stops: {
      ...labels.stops,
      copySl: sourceNounToProvider(labels.stops.copySl),
      copyTp: sourceNounToProvider(labels.stops.copyTp),
      closeOnExit: sourceNounToProvider(labels.stops.closeOnExit),
    },
    filters: {
      ...labels.filters,
      minVolume: sourceNounToProvider(labels.filters.minVolume),
      maxVolume: sourceNounToProvider(labels.filters.maxVolume),
      maxPositionAge: sourceNounToProvider(labels.filters.maxPositionAge),
    },
  }
}

/** Map social copy-setup copy onto the Mirror configure modal setup shape. */
export function socialCopySetupToMirrorSetup(c: SocialCopySetup): SetupCopy {
  return {
    title: c.configureTitle ?? c.title,
    preview: c.previewLabel,
    subtitle: c.subtitle,
    copyMethod: c.copyMethod,
    protections: c.protections,
    moreSettings: 'More limits',
    symbolMapping: {
      title: 'Symbol mapping',
      hint: "Rename the provider's symbols to the names this account uses (for example XAUUSD to GOLD). Symbols not listed copy unchanged.",
      master: 'Provider symbol',
      slave: 'Your symbol',
      add: 'Add mapping',
      remove: 'Remove mapping',
      empty: 'No mappings yet — symbols copy with their original names.',
    },
    exampleTrade: c.traderAction,
    masterSize: c.traderSize,
    slaveAccount: c.destinationAccount,
    estimatedLot: c.estimatedCopiedLot,
    copied: c.copied,
    notCopied: c.notCopied,
    riskProfile: c.riskProfile,
    estimateUnavailable: c.estimateUnavailable,
    lots: c.lots,
    done: c.done,
    advanced: 'Advanced',
    advancedHint: 'Show every copy method and limit.',
    proportional: c.proportional,
    riskMultiplier: c.riskMultiplier,
    proportionalProfile: c.proportionalProfile,
    fixedCopiedLot: c.fixedCopiedLot,
    copiedLot: c.copiedLot,
    modes: {
      fixed_lot: c.fixedLotDescription,
      lot_multiplier: c.riskMultiplierDescription,
      balance_ratio: c.proportionalDescription,
      equity_ratio: c.proportionalDescription,
      percent_risk: 'Risk a percent of equity if the stop is hit.',
      cash_risk: 'Risk a cash amount if the stop is hit.',
      stop_distance: "Scale the lot from the provider's stop distance.",
    },
  }
}
