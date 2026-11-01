import clsx from 'clsx'

import type { AccountKind } from '../../lib/providerApplication'

const LABEL: Record<AccountKind, string> = { demo: 'Demo', live: 'Live', prop: 'Prop', unknown: 'Unknown' }

export function AccountKindBadge({ kind }: { kind: AccountKind }) {
  return (
    <span className={clsx(
      'inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
      kind === 'demo' && 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
      kind === 'live' && 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
      kind === 'prop' && 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
      kind === 'unknown' && 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
    )}>
      {LABEL[kind]}
    </span>
  )
}
