import type { LegalDocumentPageTranslations } from './types'
import { legalContactEn } from './contactEn'

export const termsOfServiceEn: LegalDocumentPageTranslations = {
  title: 'Terms of Service',
  lastUpdated: 'Last updated: June 8, 2026',
  intro:
    'These Terms of Service ("Terms") govern your access to and use of TSCopier websites, applications, and related services (collectively, the "Service") operated by Tartarix, Inc. ("Tartarix," "we," "us," or "our"). By creating an account or using the Service, you agree to these Terms. If you do not agree, do not use the Service.',
  sections: [
    {
      title: '1. Eligibility and account',
      paragraphs: [
        'You must be at least 18 years old (or the age of majority in your jurisdiction) and able to form a binding contract. You are responsible for maintaining the confidentiality of your login credentials and for all activity under your account.',
        'You agree to provide accurate registration information and to keep it current. We may suspend or terminate accounts that are fraudulent, abusive, or violate these Terms.',
      ],
    },
    {
      title: '2. The Service',
      paragraphs: [
        'TSCopier is a software tool that helps users connect MetaTrader accounts to Telegram signal channels and automate trade-copying workflows according to user configuration. We are not a broker, exchange, custodian, investment adviser, or portfolio manager.',
        'We do not execute trades on our own behalf for you, hold your funds, or provide personalized financial advice. All trading occurs on third-party broker platforms subject to their terms.',
      ],
    },
    {
      title: '3. No investment advice',
      paragraphs: [
        'Information provided through the Service — including signal text, analytics, backtests, and documentation — is for informational and operational purposes only. Nothing constitutes a recommendation to buy or sell any instrument.',
        'You alone decide whether to copy any signal, which channels to follow, and how to size risk. Past performance does not guarantee future results.',
      ],
    },
    {
      title: '4. Your responsibilities',
      paragraphs: [
        'You are solely responsible for your trading decisions, tax obligations, regulatory compliance, and compliance with your broker’s terms. You must supervise copied trades and your account at all times.',
        'You will not use the Service for unlawful activity, market manipulation, unauthorized access, reverse engineering, scraping at abusive rates, or interfering with other users or infrastructure.',
        'You represent that you have the right to connect any Telegram channel and broker account you link, and that your use does not violate third-party rights or agreements.',
      ],
    },
    {
      title: '5. Subscriptions and billing',
      paragraphs: [
        'Paid features require an active subscription. Fees, billing cycles, and plan limits are described at checkout and in the app. Payments are processed by our payment provider (e.g., Stripe). We do not store full payment card numbers on our servers.',
        'Unless required by law or stated otherwise at purchase, subscription fees are non-refundable. We may change pricing with notice; continued use after the effective date constitutes acceptance.',
      ],
    },
    {
      title: '6. Third-party services',
      paragraphs: [
        'The Service integrates with third parties including brokers (via MetaTrader connectivity APIs), Telegram, Supabase, analytics providers, and payment processors. Your use of those services is governed by their separate terms and privacy policies.',
        'We are not responsible for outages, errors, or policy changes by third parties, including missed signals, failed orders, or account restrictions imposed by a broker.',
      ],
    },
    {
      title: '7. Intellectual property',
      paragraphs: [
        'The Service, including software, branding, and documentation, is owned by Tartarix or its licensors and protected by intellectual property laws. We grant you a limited, non-exclusive, non-transferable license to use the Service for your personal or internal business purposes while your account is in good standing.',
        'You may not copy, modify, distribute, sell, or create derivative works of the Service except as expressly permitted.',
      ],
    },
    {
      title: '8. Disclaimers',
      paragraphs: [
        'THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.',
        'We do not warrant uninterrupted, secure, or error-free operation, accurate signal parsing, or that copying will achieve any particular result.',
      ],
    },
    {
      title: '9. Limitation of liability',
      paragraphs: [
        'TO THE MAXIMUM EXTENT PERMITTED BY LAW, TARTARIX AND ITS OFFICERS, DIRECTORS, EMPLOYEES, AND SUPPLIERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF PROFITS, DATA, GOODWILL, OR TRADING LOSSES, ARISING FROM YOUR USE OF THE SERVICE.',
        'OUR TOTAL LIABILITY FOR ANY CLAIM ARISING OUT OF THESE TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US IN THE TWELVE (12) MONTHS BEFORE THE CLAIM OR (B) ONE HUNDRED U.S. DOLLARS (USD $100).',
      ],
    },
    {
      title: '10. Indemnification',
      paragraphs: [
        'You agree to defend, indemnify, and hold harmless Tartarix from claims, damages, and expenses (including reasonable attorneys’ fees) arising from your use of the Service, your trading activity, your breach of these Terms, or your violation of any law or third-party right.',
      ],
    },
    {
      title: '11. Termination',
      paragraphs: [
        'You may stop using the Service at any time. We may suspend or terminate access if you breach these Terms, if required by law, or if we discontinue the Service.',
        'Sections that by nature should survive (including disclaimers, limitation of liability, and indemnification) survive termination.',
      ],
    },
    {
      title: '12. Dispute resolution',
      paragraphs: [
        'Before filing a formal dispute, contact disputes@tscopier.ai and allow a reasonable time to resolve the issue informally.',
        'These Terms are governed by the laws of the State of Delaware, USA, without regard to conflict-of-law rules. Except where prohibited, you agree that exclusive jurisdiction for disputes relating to these Terms or the Service lies in the state or federal courts located in Delaware, and you consent to personal jurisdiction there.',
      ],
    },
    {
      title: '13. Changes',
      paragraphs: [
        'We may update these Terms from time to time. We will post the revised version with a new "Last updated" date. Material changes may also be notified by email or in-app notice. Continued use after changes become effective constitutes acceptance.',
      ],
    },
  ],
  closing:
    'If you have questions about these Terms, contact legal@tscopier.ai.',
  contact: legalContactEn,
}
