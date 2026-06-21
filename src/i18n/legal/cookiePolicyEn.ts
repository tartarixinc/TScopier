import type { LegalDocumentPageTranslations } from './types'
import { legalContactEn } from './contactEn'

export const cookiePolicyEn: LegalDocumentPageTranslations = {
  title: 'Cookie Policy',
  lastUpdated: 'Last updated: June 8, 2026',
  intro:
    'This Cookie Policy explains how Tartarix, Inc. ("we," "us," or "our") uses cookies and similar technologies on TScopier websites and applications. It should be read together with our Privacy Policy.',
  sections: [
    {
      title: '1. What are cookies?',
      paragraphs: [
        'Cookies are small text files stored on your device when you visit a website. Similar technologies include local storage, session storage, and pixels. They help sites remember preferences, keep you signed in, and understand how the Service is used.',
      ],
    },
    {
      title: '2. How we use cookies',
      paragraphs: [
        'Essential cookies: required for authentication, security, referral attribution, and core functionality (e.g., session state, auth presence across subdomains where configured). These cannot be disabled while using the Service.',
        'Preference cookies: remember choices such as language, cookie consent status, and dismissed banners.',
        'Analytics cookies: when you accept cookies in our banner, we may use Google Analytics and related identifiers to understand traffic and feature usage. Analytics events may include page paths, referral codes, and pseudonymous IDs — not your broker passwords or trade instructions.',
      ],
    },
    {
      title: '3. Cookies we set',
      paragraphs: [
        'Examples include: authentication/session cookies from our auth provider; tsc_tracking_consent and tsc_tracking_seen_ts (your cookie banner choice); tsc_analytics_id (pseudonymous analytics ID when analytics runs); tsc_ref and tsc_ref_ts (referral attribution); tsc_auth (short-lived cross-subdomain login hint where enabled).',
        'Names and lifetimes may change as we improve the Service. Essential cookies generally expire when you log out or after a defined security period.',
      ],
    },
    {
      title: '4. Third-party cookies',
      paragraphs: [
        'Third parties such as Google (Analytics), Stripe (checkout), and our hosting providers may set their own cookies when you interact with their features. Their use is governed by their policies.',
      ],
    },
    {
      title: '5. Your choices',
      paragraphs: [
        'When you first visit, our cookie banner lets you accept or dismiss non-essential tracking. You can change your browser settings to block or delete cookies; blocking essential cookies may prevent login or core features from working.',
        'To opt out of Google Analytics in supported regions, you may also use Google’s browser add-on or your browser’s privacy controls.',
      ],
    },
    {
      title: '6. Updates',
      paragraphs: [
        'We may update this Cookie Policy from time to time. The "Last updated" date at the top reflects the latest version.',
      ],
    },
  ],
  closing:
    'Questions about cookies? Contact legal@tscopier.ai or see our Privacy Policy.',
  contact: legalContactEn,
}
