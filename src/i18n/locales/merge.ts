import type { Translations } from './types'
import { buildCopierLogsSkipReasons } from './copierSkipReasons'

/** Overlay translated modules onto the English bundle for incremental locale rollout. */
export function mergeLocaleBundle(
  base: Translations,
  overrides: Partial<Translations>,
): Translations {
  const merged: Translations = { ...base, ...overrides }

  // `copierLogs` (and nested maps) are often partial in logs/* bundles. Shallow
  // merge would wipe English skipReasons / detailModal / closeReasons.
  if (overrides.copierLogs || overrides.channelWorker) {
    const baseLogs = base.copierLogs
    const overLogs = overrides.copierLogs
    const channelWorkerSkip =
      overrides.channelWorker?.skipReasons ?? merged.channelWorker?.skipReasons

    merged.copierLogs = {
      ...baseLogs,
      ...overLogs,
      closeReasons: {
        ...baseLogs.closeReasons,
        ...overLogs?.closeReasons,
      },
      // English catalog → localized Channel Worker → locale-specific overrides.
      skipReasons: buildCopierLogsSkipReasons(
        channelWorkerSkip,
        overLogs?.skipReasons ?? {},
        baseLogs.skipReasons,
      ),
      skipReasonDetails: {
        ...(baseLogs.skipReasonDetails ?? {}),
        ...(overLogs?.skipReasonDetails ?? {}),
      },
      detailModal: {
        ...(baseLogs.detailModal ?? {}),
        ...(overLogs?.detailModal ?? {}),
      } as Translations['copierLogs']['detailModal'],
    }
  }

  return merged
}
