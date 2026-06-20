import type { ContactSupportPageTranslations } from './types'

export const contactSupportEn: ContactSupportPageTranslations = {
  channelsTitle: 'How can we help?',
  channelsSubtitle: 'Reach the TScopier team by email, browse the docs, or start a live chat.',
  email: {
    title: 'Email support',
    description: 'Send account, billing, or copier questions — we typically reply within one business day.',
    cta: 'Email support',
  },
  docs: {
    title: 'Documentation',
    description: 'Step-by-step guides for linking brokers, Telegram channels, trade styles, and troubleshooting.',
    cta: 'Open docs',
  },
  liveChat: {
    title: 'Live chat',
    description: 'Chat with us in real time for quick setup help while you are in the dashboard.',
    cta: 'Start live chat',
  },
  faq: {
    title: 'Frequently asked questions',
    subtitle: 'Quick answers before you reach out.',
    items: [
      {
        question: 'How do I connect my MetaTrader account?',
        answer:
          'Open Configuration, add a broker account, enter your MetaTrader login details, and wait until the connection status shows connected. Each linked account needs trade style, lot sizing, and channel selection saved before copying starts.',
      },
      {
        question: 'Why are my Telegram signals not copying?',
        answer:
          'Check that your broker is connected, the Telegram channel is linked and active, the channel is selected on the broker in Configuration, your subscription is active, and your email is verified. Review Copier Logs for skip reasons such as channel filters, news blackout, or missing SL/TP on the signal.',
      },
      {
        question: 'How do I add a Telegram signal channel?',
        answer:
          'Go to Channels, connect Telegram if needed, then add the channel username or invite link. Enable the channel and assign it to the broker accounts that should copy its signals in Configuration.',
      },
      {
        question: 'What does news trading / economic calendar blackout do?',
        answer:
          'When news trading is disabled on an account, TScopier can pause new entries and optionally close open trades around high-impact calendar events. Use the Economic Calendar page to see upcoming releases and configure rules under Account Configuration.',
      },
      {
        question: 'Do I need a paid subscription to copy trades?',
        answer:
          'An active paid plan is required for live Telegram copier execution. You can still explore the dashboard and configuration on a free trial where available; check Billing for your current plan and renewal status.',
      },
      {
        question: 'Why must I verify my email before using the platform?',
        answer:
          'Email verification confirms your login and lets us send billing receipts and important account alerts. If you are stuck on the verification screen, use the resend link or contact support with the address you signed up with.',
      },
      {
        question: 'My broker shows disconnected — what should I try?',
        answer:
          'Confirm MetaTrader is running on your broker side, credentials are still valid, and the account is not locked. Refresh from Configuration, then check Copier Logs for session errors. If it persists, email support with your broker name and account login (never your password).',
      },
      {
        question: 'Can I copy the same channel to multiple brokers?',
        answer:
          'Yes. Link each MetaTrader account separately in Configuration and select the same Telegram channel on each broker. Lot sizing, trade style, and risk settings are per account.',
      },
    ],
  },
}
