import type { LegalDocumentPageTranslations } from './types'
import { legalContactNl } from './contactNl'

export const cookiePolicyNl: LegalDocumentPageTranslations = {
  title: 'Cookiebeleid',
  lastUpdated: 'Laatst bijgewerkt: 8 juni 2026',
  intro:
    'Dit Cookiebeleid legt uit hoe Tartarix, Inc. ("wij", "ons" of "onze") cookies en vergelijkbare technologieën gebruikt op de websites en applicaties van TScopier. Dit beleid moet samen met ons Privacybeleid worden gelezen.',
  sections: [
    {
      title: '1. Wat zijn cookies?',
      paragraphs: [
        'Cookies zijn kleine tekstbestanden die op uw apparaat worden opgeslagen wanneer u een website bezoekt. Vergelijkbare technologieën zijn onder andere local storage, session storage en pixels. Ze helpen websites voorkeuren te onthouden, u ingelogd te houden en te begrijpen hoe de Dienst wordt gebruikt.',
      ],
    },
    {
      title: '2. Hoe wij cookies gebruiken',
      paragraphs: [
        'Essentiële cookies: vereist voor authenticatie, beveiliging, referral-attributie en kernfunctionaliteit (bijv. sessiestatus, auth-aanwezigheid over subdomeinen waar geconfigureerd). Deze kunnen niet worden uitgeschakeld tijdens het gebruik van de Dienst.',
        'Voorkeurscookies: onthouden keuzes zoals taal, cookie-toestemmingsstatus en gesloten banners.',
        'Analytics-cookies: wanneer u cookies accepteert in onze banner, kunnen wij Google Analytics en gerelateerde identificatoren gebruiken om verkeer en functiegebruik te begrijpen. Analyticsgebeurtenissen kunnen paginapaden, referralcodes en pseudonieme ID\'s bevatten — niet uw brokerwachtwoorden of handelsinstructies.',
      ],
    },
    {
      title: '3. Cookies die wij plaatsen',
      paragraphs: [
        'Voorbeelden zijn: authenticatie-/sessiecookies van onze auth-provider; tsc_tracking_consent en tsc_tracking_seen_ts (uw keuze in de cookiebanner); tsc_analytics_id (pseudonieme analytics-ID wanneer analytics actief is); tsc_ref en tsc_ref_ts (referral-attributie); tsc_auth (kortdurende inloghint tussen subdomeinen waar ingeschakeld).',
        'Namen en bewaartermijnen kunnen wijzigen terwijl wij de Dienst verbeteren. Essentiële cookies verlopen doorgaans wanneer u uitlogt of na een vastgestelde beveiligingsperiode.',
      ],
    },
    {
      title: '4. Cookies van derden',
      paragraphs: [
        'Derden zoals Google (Analytics), Stripe (checkout) en onze hostingproviders kunnen eigen cookies plaatsen wanneer u met hun functies interacteert. Hun gebruik valt onder hun eigen beleid.',
      ],
    },
    {
      title: '5. Uw keuzes',
      paragraphs: [
        'Bij uw eerste bezoek laat onze cookiebanner u niet-essentiële tracking accepteren of afwijzen. U kunt uw browserinstellingen aanpassen om cookies te blokkeren of te verwijderen; het blokkeren van essentiële cookies kan inloggen of kernfunctionaliteit verhinderen.',
        'Om u af te melden voor Google Analytics in ondersteunde regio\'s kunt u ook de browseradd-on van Google of privacyinstellingen van uw browser gebruiken.',
      ],
    },
    {
      title: '6. Updates',
      paragraphs: [
        'Wij kunnen dit Cookiebeleid van tijd tot tijd bijwerken. De datum "Laatst bijgewerkt" bovenaan toont de meest recente versie.',
      ],
    },
  ],
  closing:
    'Vragen over cookies? Neem contact op via legal@tscopier.ai of bekijk ons Privacybeleid.',
  contact: legalContactNl,
}
