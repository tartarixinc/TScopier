import { useT } from '../../../../context/LocaleContext'

const ORBIT_ICONS = [
  { src: '/Telegram.svg', key: 'telegram' as const },
  { src: '/MT5.png', key: 'mt5' as const },
  { src: '/MT4.png', key: 'mt4' as const },
]

export function IntegrationsVisual() {
  const v = useT().landing.features.visuals.integrations

  return (
    <div className="relative flex h-full min-h-[240px] items-center justify-center">
      <div className="marketing-feature-orbit-ring marketing-feature-orbit-ring--outer" aria-hidden />
      <div className="marketing-feature-orbit-ring marketing-feature-orbit-ring--inner" aria-hidden />
      <div className="marketing-feature-pulse-ring" aria-hidden />

      <div className="marketing-feature-hub relative z-10 px-6">
        <span className="text-sm font-semibold text-white">{v.hubLabel}</span>
      </div>

      {ORBIT_ICONS.map((icon, i) => (
        <div
          key={icon.key}
          className={`marketing-feature-orbit-icon marketing-feature-orbit-icon--${i + 1}`}
        >
          <img src={icon.src} alt="" className="h-10 w-10 object-contain" />
          <span className="mt-1 text-[10px] font-semibold text-neutral-700 dark:text-neutral-200">
            {v.labels[icon.key]}
          </span>
        </div>
      ))}
    </div>
  )
}
