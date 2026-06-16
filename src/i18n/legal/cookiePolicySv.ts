import type { LegalDocumentPageTranslations } from './types'
import { legalContactSv } from './contactSv'

export const cookiePolicySv: LegalDocumentPageTranslations = {
  title: 'Cookiepolicy',
  lastUpdated: 'Senast uppdaterad: 8 juni 2026',
  intro:
    'Denna Cookiepolicy förklarar hur Tartarix, Inc. ("vi", "oss" eller "vår") använder cookies och liknande tekniker på TSCopiers webbplatser och applikationer. Den ska läsas tillsammans med vår Integritetspolicy.',
  sections: [
    {
      title: '1. Vad är cookies?',
      paragraphs: [
        'Cookies är små textfiler som lagras på din enhet när du besöker en webbplats. Liknande tekniker inkluderar local storage, session storage och pixlar. De hjälper webbplatser att komma ihåg inställningar, hålla dig inloggad och förstå hur Tjänsten används.',
      ],
    },
    {
      title: '2. Hur vi använder cookies',
      paragraphs: [
        'Nödvändiga cookies: krävs för autentisering, säkerhet, hänvisningsattribuering och kärnfunktionalitet (t.ex. sessionsstatus, auth-närvaro över subdomäner där det är konfigurerat). Dessa kan inte stängas av under användning av Tjänsten.',
        'Inställningscookies: kommer ihåg val såsom språk, samtyckesstatus för cookies och stängda banners.',
        'Analyscookies: när du godkänner cookies i vår banner kan vi använda Google Analytics och relaterade identifierare för att förstå trafik och funktionsanvändning. Analysdata kan inkludera sidvägar, hänvisningskoder och pseudonyma ID:n — inte dina mäklarlösenord eller handelsinstruktioner.',
      ],
    },
    {
      title: '3. Cookies vi sätter',
      paragraphs: [
        'Exempel inkluderar: autentiserings-/sessionscookies från vår auth-leverantör; tsc_tracking_consent och tsc_tracking_seen_ts (ditt val i cookiebannern); tsc_analytics_id (pseudonymt analys-ID när analys är aktiv); tsc_ref och tsc_ref_ts (hänvisningsattribuering); tsc_auth (kortlivad inloggningssignal mellan subdomäner där aktiverat).',
        'Namn och livslängder kan förändras när vi förbättrar Tjänsten. Nödvändiga cookies löper vanligtvis ut när du loggar ut eller efter en definierad säkerhetsperiod.',
      ],
    },
    {
      title: '4. Tredjepartscookies',
      paragraphs: [
        'Tredje parter såsom Google (Analytics), Stripe (checkout) och våra hostingleverantörer kan sätta egna cookies när du använder deras funktioner. Deras användning regleras av deras egna policyer.',
      ],
    },
    {
      title: '5. Dina val',
      paragraphs: [
        'När du besöker oss första gången låter vår cookiebanner dig acceptera eller avvisa icke-nödvändig spårning. Du kan ändra webbläsarinställningar för att blockera eller radera cookies; blockering av nödvändiga cookies kan förhindra inloggning eller kärnfunktioner.',
        'För att välja bort Google Analytics i regioner där det stöds kan du även använda Googles webbläsartillägg eller webbläsarens integritetsinställningar.',
      ],
    },
    {
      title: '6. Uppdateringar',
      paragraphs: [
        'Vi kan uppdatera denna Cookiepolicy från tid till annan. Datumet "Senast uppdaterad" högst upp visar den senaste versionen.',
      ],
    },
  ],
  closing:
    'Frågor om cookies? Kontakta legal@tscopier.ai eller läs vår Integritetspolicy.',
  contact: legalContactSv,
}
