/**
 * Feature switches controlled by Netlify environment variables.
 *
 * Both switches default to ON, so staging, migration, and local builds stay
 * fully visible without any setup. Production sets the variables to "false"
 * in the Netlify dashboard to hide a feature; switching them back on and
 * redeploying restores it without a code change.
 *
 * - VITE_ENABLE_EXTRA_SOURCES: locks Discord and TradingView in the source
 *   pickers ("Coming soon" when off). Telegram and WhatsApp stay selectable
 *   because both have a worker.
 * - VITE_ENABLE_SOCIAL_TRADING: social trading everywhere, including the
 *   public provider profile pages on the marketing site.
 *
 * Netlify bakes these variables into the build, so a changed value takes
 * effect on the next deploy.
 *
 * Before the first production deploy, set BOTH variables to "false" in the
 * Netlify dashboard of the production site — a deploy without them ships both
 * features to customers. Only the exact value "false" (any case, surrounding
 * spaces ignored) disables a feature; a typo such as "fasle" leaves it visible.
 */

export interface BuildFeatureFlags {
  /** Extra signal sources are locked: Discord and TradingView show "Coming soon". */
  extraSourcesLocked: boolean
  /** Hide social trading (menu, routes, search, settings, public profiles). */
  hideSocialTrading: boolean
}

/** A switch is off only when the variable is explicitly "false". */
function switchEnabled(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() !== 'false'
}

/** Resolve the flags from the raw environment values. */
export function resolveBuildFlags(env: {
  extraSources?: string
  socialTrading?: string
}): BuildFeatureFlags {
  return {
    extraSourcesLocked: !switchEnabled(env.extraSources),
    hideSocialTrading: !switchEnabled(env.socialTrading),
  }
}

/** Flags for the current build. Unset variables mean the feature is on. */
export const buildFlags: BuildFeatureFlags = resolveBuildFlags({
  extraSources: import.meta.env.VITE_ENABLE_EXTRA_SOURCES as string | undefined,
  socialTrading: import.meta.env.VITE_ENABLE_SOCIAL_TRADING as string | undefined,
})

/** Sources that show "Coming soon" while the switch is off: they have no worker yet. */
const LOCKED_WHILE_OFF = ['discord', 'tradingview']

/** True when a signal source must be greyed out with "Coming soon" in this build. */
export function isSignalSourceLocked(kind: string): boolean {
  return buildFlags.extraSourcesLocked && LOCKED_WHILE_OFF.includes(kind)
}
