import { Radio, ShieldCheck, Zap } from 'lucide-react'
import { AuthBrandLogo } from './AuthBrandLogo'

const features = [
  {
    icon: Radio,
    title: 'Connect any signal channel',
    description: 'Link Telegram channels and copy trades to your broker in seconds.',
  },
  {
    icon: Zap,
    title: 'Execute with precision',
    description: 'Keyword parsing, TP ladders, and basket logic built for real channels.',
  },
  {
    icon: ShieldCheck,
    title: 'Stay in control',
    description: 'Per-channel rules, risk limits, and live logs on every signal.',
  },
]

export function AuthMarketingPanel() {
  return (
    <aside className="relative hidden lg:flex lg:w-[min(52%,400px)] shrink-0 flex-col justify-between overflow-hidden bg-primary-950 text-white p-10 xl:p-14">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_20%_0%,rgba(45,212,191,0.22),transparent),radial-gradient(ellipse_60%_50%_at_100%_100%,rgba(13,148,136,0.35),transparent)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.8) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
        aria-hidden
      />

      <div className="relative z-10">
        <AuthBrandLogo className="h-8 w-auto max-w-[140px]" />
      </div>

      <div className="relative z-10 space-y-10">
        <div>
    
          <h1 className="text-3xl xl:text-2xl font-semibold leading-tight tracking-tight text-white">
            One Seamless Copier for every Telegram Signal
          </h1>
        </div>

        <ul className="space-y-5">
          {features.map(({ icon: Icon, title, description }) => (
            <li key={title} className="flex gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/10">
                <Icon className="h-5 w-5 text-teal-300" strokeWidth={1.75} />
              </span>
              <span>
                <p className="text-sm font-medium text-white">{title}</p>
                <p className="text-sm text-white/55 mt-0.5 leading-snug">{description}</p>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative z-10 text-xs text-white/35">
        © {new Date().getFullYear()} Tartarix Inc.
      </p>
    </aside>
  )
}
