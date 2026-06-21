import { useState } from 'react'
import { ChevronDown, BookOpen, Mail, MessageCircle } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { DOCS_URL, SUPPORT_EMAIL } from '../../lib/supportContacts'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { LiveChatWidget, maximizeLiveChat, type LiveChatVisibility } from '../../components/layout/LiveChatWidget'
import { Button } from '../../components/ui/Button'

function ContactChannelCard({
  icon: Icon,
  title,
  description,
  detail,
  actionLabel,
  onAction,
  href,
  external,
}: {
  icon: typeof Mail
  title: string
  description: string
  detail?: string
  actionLabel: string
  onAction?: () => void
  href?: string
  external?: boolean
}) {
  const actionClass =
    'inline-flex items-center gap-1.5 text-sm font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300'

  return (
    <article className="flex h-full flex-col rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 sm:p-6">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-50 text-teal-600 dark:bg-teal-950/50 dark:text-teal-400">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <h2 className="mt-4 text-base font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
      <p className="mt-2 flex-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{description}</p>
      {detail ? (
        <p className="mt-3 break-all text-sm font-medium text-neutral-800 dark:text-neutral-200">{detail}</p>
      ) : null}
      <div className="mt-4">
        {href ? (
          <a
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
            className={actionClass}
          >
            {actionLabel}
          </a>
        ) : (
          <button type="button" onClick={onAction} className={actionClass}>
            {actionLabel}
          </button>
        )}
      </div>
    </article>
  )
}

export function ContactSupportPage() {
  const t = useT()
  const page = t.pages.contactSupport
  const cs = t.contactSupportPage
  const [chatVisibility, setChatVisibility] = useState<LiveChatVisibility>('minimized')
  const openLiveChat = () => {
    setChatVisibility('maximized')
    maximizeLiveChat()
  }

  return (
    <PageShell maxWidth="lg" spacing="loose">
      <LiveChatWidget visibility={chatVisibility} onVisibilityChanged={setChatVisibility} />
      <PageHeader title={page.title} subtitle={page.description} />

      <section aria-labelledby="support-channels-heading">
        <div className="mb-4">
          <h2 id="support-channels-heading" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {cs.channelsTitle}
          </h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{cs.channelsSubtitle}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <ContactChannelCard
            icon={Mail}
            title={cs.email.title}
            description={cs.email.description}
            detail={SUPPORT_EMAIL}
            actionLabel={cs.email.cta}
            href={`mailto:${SUPPORT_EMAIL}`}
          />
          <ContactChannelCard
            icon={BookOpen}
            title={cs.docs.title}
            description={cs.docs.description}
            detail={DOCS_URL.replace(/^https?:\/\//, '')}
            actionLabel={cs.docs.cta}
            href={DOCS_URL}
            external
          />
          <ContactChannelCard
            icon={MessageCircle}
            title={cs.liveChat.title}
            description={cs.liveChat.description}
            actionLabel={cs.liveChat.cta}
            onAction={openLiveChat}
          />
        </div>
      </section>

      <section aria-labelledby="support-faq-heading">
        <div className="mb-4">
          <h2 id="support-faq-heading" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {cs.faq.title}
          </h2>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{cs.faq.subtitle}</p>
        </div>
        <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
          {cs.faq.items.map((item, index) => (
            <details
              key={item.question}
              className={clsx(
                'group border-neutral-200 dark:border-neutral-800',
                index > 0 && 'border-t',
              )}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-left text-sm font-medium text-neutral-900 marker:content-none dark:text-neutral-50 sm:px-6">
                <span>{item.question}</span>
                <ChevronDown
                  className="h-5 w-5 shrink-0 text-neutral-400 transition-transform duration-200 group-open:rotate-180 dark:text-neutral-500"
                  aria-hidden
                />
              </summary>
              <p className="border-t border-neutral-100 px-5 pb-4 pt-0 text-sm leading-relaxed text-neutral-600 dark:border-neutral-800 dark:text-neutral-400 sm:px-6 sm:pb-5">
                {item.answer}
              </p>
            </details>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" onClick={openLiveChat}>
            <MessageCircle className="h-4 w-4" />
            {cs.liveChat.cta}
          </Button>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-sm font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
          >
            {SUPPORT_EMAIL}
          </a>
        </div>
      </section>
    </PageShell>
  )
}
