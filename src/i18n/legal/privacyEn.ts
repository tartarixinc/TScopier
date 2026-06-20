import type { LegalDocumentPageTranslations } from './types'
import { legalContactEn } from './contactEn'

export const privacyPolicyEn: LegalDocumentPageTranslations = {
  title: 'Privacy Policy',
  lastUpdated: 'Last updated: June 8, 2026',
  intro:
    'Tartarix, Inc. ("Tartarix," "we," "us," or "our") respects your privacy. This Privacy Policy explains how we collect, use, disclose, and protect information when you use TScopier websites and applications (the "Service").',
  sections: [
    {
      title: '1. Information we collect',
      paragraphs: [
        'Account information: name, email address, password hash, language and profile preferences, subscription status, and referral codes.',
        'Broker and trading configuration: broker labels, account logins (not passwords stored in plain text), platform type, channel selections, copier settings, and execution logs needed to operate the Service.',
        'Trading and signal data: Telegram channel identifiers, parsed signal content, trade records, skip reasons, and performance metrics associated with your account.',
        'Payment information: billing status and customer identifiers from our payment processor. Card details are handled by the processor, not stored by us.',
        'Technical data: IP address, browser type, device information, cookies, analytics identifiers, and usage events (see our Cookie Policy).',
        'Communications: messages you send to support, legal, or disputes email addresses.',
      ],
    },
    {
      title: '2. How we use information',
      paragraphs: [
        'Provide, maintain, and improve the Service; authenticate users; process subscriptions; execute configured copy-trading workflows; display dashboards and logs.',
        'Send transactional emails (verification, billing, security notices) and respond to support requests.',
        'Monitor reliability, prevent fraud and abuse, enforce our Terms, and comply with legal obligations.',
        'Analyze aggregated usage to improve product features (subject to your cookie choices where applicable).',
      ],
    },
    {
      title: '3. Legal bases (EEA/UK users)',
      paragraphs: [
        'Where GDPR or similar laws apply, we process personal data based on: performance of a contract (providing the Service), legitimate interests (security, analytics, product improvement), consent (non-essential cookies/marketing where required), and legal obligation.',
      ],
    },
    {
      title: '4. How we share information',
      paragraphs: [
        'Service providers: hosting and database (e.g., Supabase), payment processing (e.g., Stripe), email delivery, analytics (e.g., Google Analytics when consented), broker connectivity APIs, and customer support tools — only as needed to operate the Service.',
        'We do not sell your personal information. We may disclose information if required by law, to protect rights and safety, or in connection with a merger, acquisition, or asset sale with appropriate safeguards.',
      ],
    },
    {
      title: '5. International transfers',
      paragraphs: [
        'We may process and store information in the United States and other countries where we or our providers operate. We use appropriate safeguards for cross-border transfers where required by law.',
      ],
    },
    {
      title: '6. Retention',
      paragraphs: [
        'We retain information while your account is active and as needed to provide the Service, resolve disputes, enforce agreements, and meet legal requirements. You may request deletion subject to exceptions (e.g., billing records we must keep).',
      ],
    },
    {
      title: '7. Security',
      paragraphs: [
        'We use administrative, technical, and organizational measures designed to protect information. No method of transmission or storage is 100% secure; we cannot guarantee absolute security.',
      ],
    },
    {
      title: '8. Your rights and choices',
      paragraphs: [
        'Depending on your location, you may have rights to access, correct, delete, restrict, or port your personal data, and to object to certain processing. You may update profile settings in the app and manage cookie preferences via our cookie banner.',
        'To exercise privacy rights, contact legal@tscopier.ai. We may verify your identity before responding. You may also lodge a complaint with your local data protection authority.',
      ],
    },
    {
      title: '9. Children',
      paragraphs: [
        'The Service is not directed to children under 18. We do not knowingly collect personal information from children. Contact us if you believe a child has provided data and we will delete it.',
      ],
    },
    {
      title: '10. Changes',
      paragraphs: [
        'We may update this Privacy Policy from time to time. We will post the revised policy with a new "Last updated" date and, where required, provide additional notice.',
      ],
    },
  ],
  closing:
    'For privacy questions or requests, contact legal@tscopier.ai.',
  contact: legalContactEn,
}
