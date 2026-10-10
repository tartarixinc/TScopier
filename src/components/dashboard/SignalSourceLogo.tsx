import clsx from 'clsx'
import { SIGNAL_SOURCE_MARKS, type SignalSourceKind } from '../../lib/signalSourceMark'

export function SignalSourceLogo({
  kind,
  className = 'h-5 w-5 shrink-0',
}: {
  kind?: SignalSourceKind | null
  className?: string
}) {
  if (!kind) return null
  const mark = SIGNAL_SOURCE_MARKS[kind]
  return (
    <img
      src={mark.iconSrc}
      alt=""
      aria-hidden
      title={mark.label}
      className={clsx(className, kind === 'telegram' ? 'object-contain' : 'rounded-full object-cover')}
    />
  )
}
