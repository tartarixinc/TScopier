import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import clsx from 'clsx'
import { TscopierLogo } from '../ui/TscopierLogo'
import { LanguageSwitcher } from '../auth/LanguageSwitcher'
import { useT } from '../../context/LocaleContext'
import { appUrl } from '../../lib/site'
import { HELP_LINKS } from '../../lib/helpLinks'
import { MarketingPricingHint } from './MarketingPricingHint'

const FOOTER_PLATFORMS = [
  { src: '/Telegram.svg', alt: 'Telegram' },
  { src: '/MT5.png', alt: 'MetaTrader 5' },
  { src: '/MT4.png', alt: 'MetaTrader 4' },
] as const

interface FooterLink {
  label: string
  href: string
  external?: boolean
  highlight?: boolean
}

function FooterNavLink({ link }: { link: FooterLink }) {
  const className = clsx(
    'text-sm transition-colors',
    link.highlight
      ? 'font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300'
      : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
  )

  if (link.href.startsWith('/') && !link.external) {
    return (
      <Link to={link.href} className={className}>
        {link.label}
      </Link>
    )
  }

  return (
    <a
      href={link.href}
      className={className}
      {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : undefined)}
    >
      {link.label}
    </a>
  )
}

function FooterNavColumn({
  title,
  links,
}: {
  title: string
  links: FooterLink[]
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {title}
      </p>
      <ul className="mt-4 space-y-2.5">
        {links.map((link) => (
          <li key={link.label}>
            <FooterNavLink link={link} />
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MarketingFooter() {
  const { landing } = useT()
  const f = landing.footer
  const { pricingSnippet } = landing
  const year = new Date().getFullYear()
  const copyright = f.copyright.replace('{year}', String(year))

  const productLinks: FooterLink[] = [
    { label: f.links.overview, href: '#product' },
    { label: f.links.features, href: '#features' },
    { label: f.links.pricing, href: '/pricing' },
    { label: f.links.howItWorks, href: '#how-it-works' },
    { label: f.links.faq, href: '#faq' },
  ]

  const resourceLinks: FooterLink[] = [
    { label: f.links.termsOfService, href: '/terms' },
    { label: f.links.privacyPolicy, href: '/privacy' },
    { label: f.links.cookiePolicy, href: '/cookie-policy' },
    { label: f.links.riskDisclaimer, href: '/risk-disclaimer' },
    { label: f.links.docs, href: HELP_LINKS.documentation, external: true },
    { label: f.links.status, href: HELP_LINKS.status, external: true },
    ...(HELP_LINKS.telegram
      ? [{ label: f.links.telegram, href: HELP_LINKS.telegram, external: true }]
      : []),
  ]

  const accountLinks: FooterLink[] = [
    { label: f.links.signIn, href: appUrl('/login') },
    { label: f.links.signUp, href: appUrl('/signup') },
    { label: f.links.openApp, href: appUrl('/dashboard'), highlight: true },
  ]

  return (
    <footer className="marketing-footer relative z-10">
      <div className="marketing-footer-cta">
        <div className="marketing-footer-cta-grid" aria-hidden />
        <div className="relative mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-14">
          <div className="flex flex-col items-start gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
            <div className="max-w-xl">
              <h2 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-3xl">
                {f.cta.title}
              </h2>
              <p className="mt-3 text-base leading-relaxed text-neutral-600 dark:text-neutral-400">
                {f.cta.subtitle}
              </p>
            </div>
            <div className="flex w-full shrink-0 flex-col items-center sm:w-auto sm:items-end">
              <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
                <a
                  href={appUrl('/signup')}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-teal-600 bg-teal-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:border-teal-700 hover:bg-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 dark:focus:ring-offset-neutral-950"
                >
                  {f.cta.primary}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </a>
                <a
                  href={appUrl('/login')}
                  className="inline-flex items-center justify-center rounded-xl border border-neutral-200 bg-white px-5 py-2.5 text-sm font-medium text-neutral-800 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
                >
                  {f.cta.secondary}
                </a>
              </div>
              <MarketingPricingHint
                basic={pricingSnippet.basic}
                advanced={pricingSnippet.advanced}
                className="mt-3 text-center text-xs leading-relaxed text-neutral-500 sm:text-right dark:text-neutral-400"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="marketing-footer-main">
        <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-14">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_repeat(3,minmax(0,1fr))] lg:gap-8">
            <div className="sm:col-span-2 lg:col-span-1">
              <Link to="/" className="inline-flex" aria-label="TScopier home">
                <TscopierLogo className="h-7 w-auto" />
              </Link>
              <p className="mt-4 max-w-xs text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
                {f.tagline}
              </p>
              <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                {f.platforms}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {FOOTER_PLATFORMS.map((platform) => (
                  <span
                    key={platform.src}
                    className="marketing-footer-platform flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200/90 bg-white shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
                    title={platform.alt}
                  >
                    <img
                      src={platform.src}
                      alt={platform.alt}
                      className="h-5 w-5 object-contain"
                      width={20}
                      height={20}
                    />
                  </span>
                ))}
              </div>
            </div>

            <FooterNavColumn title={f.columns.product} links={productLinks} />
            <FooterNavColumn title={f.columns.resources} links={resourceLinks} />
            <FooterNavColumn title={f.columns.account} links={accountLinks} />
          </div>
        </div>
      </div>

      <div className="marketing-footer-bottom">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-5 py-6 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-2 sm:gap-1">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{copyright}</p>
            <p className="max-w-2xl text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
              {f.disclaimer}
            </p>
          </div>
          <div className="flex items-center gap-3 lg:shrink-0">
            <LanguageSwitcher />
          </div>
        </div>
      </div>
    </footer>
  )
}
