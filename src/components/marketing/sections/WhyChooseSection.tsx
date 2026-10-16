import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  BarChart3,
  Clock,
  Cloud,
  History,
  Layers,
  Link2,
  MessageCircle,
  Settings,
  Zap,
} from 'lucide-react'
import { useT } from '../../../context/LocaleContext'
import type {
  LandingBentoCard,
  LandingBentoCardLayout,
  LandingBentoIcon,
} from '../../../i18n/locales/landing/types'

const ICONS: Record<LandingBentoIcon, LucideIcon> = {
  zap: Zap,
  cloud: Cloud,
  link: Link2,
  clock: Clock,
  activity: Activity,
  chart: BarChart3,
  layers: Layers,
  settings: Settings,
  messages: MessageCircle,
  history: History,
}

/** Five columns × two cards; odd columns tall→short, even columns short→tall. */
const BENTO_COLUMN_CARD_INDEXES: readonly [number, number][] = [
  [0, 1],
  [2, 6],
  [4, 5],
  [3, 7],
  [8, 9],
]

const BENTO_COLUMN_SLOTS: readonly [LandingBentoCardLayout, LandingBentoCardLayout][] = [
  ['tall', 'short'],
  ['short', 'tall'],
  ['featured', 'short'],
  ['short', 'tall'],
  ['tall', 'short'],
]

function metricClass(card: LandingBentoCard, featured: boolean): string {
  if (featured) {
    if (card.metricVariant === 'amber') return 'text-amber-300'
    return 'text-white'
  }
  if (card.metricVariant === 'teal') return 'text-green-500 dark:text-green-400'
  return 'text-neutral-900 dark:text-neutral-100'
}

function BentoCard({
  card,
  slot,
}: {
  card: LandingBentoCard
  slot: LandingBentoCardLayout
}) {
  const featured = slot === 'featured'
  const tall = slot === 'tall' || featured
  const Icon = ICONS[card.icon]

  return (
    <article
      className={clsx(
        'marketing-bento-card',
        tall ? 'marketing-bento-card--tall' : 'marketing-bento-card--short',
        featured && 'marketing-bento-card--featured',
      )}
    >
      <p
        className={clsx(
          'relative z-10 text-xs font-semibold tracking-tight',
          featured ? 'text-teal-100' : 'text-neutral-900 dark:text-neutral-50',
        )}
      >
        {card.label}
      </p>
      <p
        className={clsx(
          'relative z-10 mt-3 text-2xl font-bold leading-tight tracking-tight sm:text-3xl lg:text-[1.65rem] lg:leading-tight',
          metricClass(card, featured),
        )}
      >
        {card.metric}
      </p>
      <p
        className={clsx(
          'relative z-10 mt-auto pt-2 text-xs leading-relaxed sm:text-sm',
          featured ? 'text-teal-50/90' : 'text-neutral-900 dark:text-neutral-50',
        )}
      >
        {card.description}
      </p>
      <Icon
        className={clsx(
          'marketing-bento-watermark',
          featured ? 'text-white' : 'text-neutral-900 dark:text-neutral-50 dark:text-white',
        )}
        strokeWidth={1.25}
        aria-hidden
      />
    </article>
  )
}

export function WhyChooseSection() {
  const l = useT().landing.whyChoose
  const mobileOrder = BENTO_COLUMN_CARD_INDEXES.flat()

  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-green-400 dark:text-green-400">
          {l.eyebrow}
        </p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl lg:text-[2.5rem] lg:leading-tight">
          {l.title}
        </h2>
      </div>

      <div className="mt-10 grid gap-3 sm:mt-12 sm:grid-cols-2 sm:gap-4 lg:hidden">
        {mobileOrder.map((cardIndex) => (
          <BentoCard key={l.cards[cardIndex].label} card={l.cards[cardIndex]} slot={l.cards[cardIndex].layout} />
        ))}
      </div>

      <div className="marketing-bento-columns mt-10 hidden sm:mt-12 lg:grid">
        {BENTO_COLUMN_CARD_INDEXES.map(([topIndex, bottomIndex], columnIndex) => {
          const [topSlot, bottomSlot] = BENTO_COLUMN_SLOTS[columnIndex]
          return (
            <div key={columnIndex} className="marketing-bento-column">
              <BentoCard card={l.cards[topIndex]} slot={topSlot} />
              <BentoCard card={l.cards[bottomIndex]} slot={bottomSlot} />
            </div>
          )
        })}
      </div>
    </section>
  )
}
