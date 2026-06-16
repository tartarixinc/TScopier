import type { LegalDocumentPageTranslations } from './types'
import { legalContactSv } from './contactSv'

export const privacyPolicySv: LegalDocumentPageTranslations = {
  title: 'Integritetspolicy',
  lastUpdated: 'Senast uppdaterad: 8 juni 2026',
  intro:
    'Tartarix, Inc. ("Tartarix", "vi", "oss" eller "vår") respekterar din integritet. Denna Integritetspolicy förklarar hur vi samlar in, använder, lämnar ut och skyddar information när du använder TSCopiers webbplatser och applikationer ("Tjänsten").',
  sections: [
    {
      title: '1. Information vi samlar in',
      paragraphs: [
        'Kontoinformation: namn, e-postadress, lösenordshash, språk- och profilinställningar, prenumerationsstatus och hänvisningskoder.',
        'Mäklar- och handelskonfiguration: mäklaretiketter, kontoinloggningar (lösenord lagras inte i klartext), plattformstyp, kanalval, kopieringsinställningar och exekveringsloggar som behövs för att driva Tjänsten.',
        'Handels- och signaldata: Telegram-kanalidentifierare, tolkad signalinnehåll, handelsposter, skäl till att signaler hoppats över samt prestationsmått kopplade till ditt konto.',
        'Betalningsinformation: faktureringsstatus och kundidentifierare från vår betalningsleverantör. Kortuppgifter hanteras av leverantören och lagras inte av oss.',
        'Teknisk data: IP-adress, webbläsartyp, enhetsinformation, cookies, analysidentifierare och användningshändelser (se vår Cookiepolicy).',
        'Kommunikation: meddelanden som du skickar till support-, juridik- eller tvistadresser.',
      ],
    },
    {
      title: '2. Hur vi använder information',
      paragraphs: [
        'Tillhandahålla, underhålla och förbättra Tjänsten; autentisera användare; behandla prenumerationer; köra konfigurerade arbetsflöden för kopieringshandel; visa dashboards och loggar.',
        'Skicka transaktionsmeddelanden (verifiering, fakturering, säkerhetsmeddelanden) och besvara supportförfrågningar.',
        'Övervaka tillförlitlighet, förebygga bedrägeri och missbruk, upprätthålla våra Villkor och uppfylla rättsliga skyldigheter.',
        'Analysera aggregerad användning för att förbättra produktfunktioner (med förbehåll för dina cookieval där tillämpligt).',
      ],
    },
    {
      title: '3. Rättsliga grunder (användare i EES/Storbritannien)',
      paragraphs: [
        'När GDPR eller liknande lagar gäller behandlar vi personuppgifter med stöd av: fullgörande av avtal (tillhandahålla Tjänsten), berättigat intresse (säkerhet, analys, produktförbättring), samtycke (icke-nödvändiga cookies/marknadsföring där det krävs) samt rättslig förpliktelse.',
      ],
    },
    {
      title: '4. Hur vi delar information',
      paragraphs: [
        'Tjänsteleverantörer: hosting och databas (t.ex. Supabase), betalningshantering (t.ex. Stripe), e-postleverans, analys (t.ex. Google Analytics när samtycke finns), API:er för mäklaranslutning och kundsupportverktyg — endast i den utsträckning som behövs för att driva Tjänsten.',
        'Vi säljer inte dina personuppgifter. Vi kan lämna ut information om det krävs enligt lag, för att skydda rättigheter och säkerhet, eller i samband med en fusion, ett förvärv eller en tillgångsförsäljning med lämpliga skyddsåtgärder.',
      ],
    },
    {
      title: '5. Internationella överföringar',
      paragraphs: [
        'Vi kan behandla och lagra information i USA och andra länder där vi eller våra leverantörer bedriver verksamhet. Vi använder lämpliga skyddsåtgärder för gränsöverskridande överföringar där lag kräver det.',
      ],
    },
    {
      title: '6. Lagring',
      paragraphs: [
        'Vi lagrar information så länge ditt konto är aktivt och så länge det behövs för att tillhandahålla Tjänsten, lösa tvister, verkställa avtal och uppfylla rättsliga krav. Du kan begära radering med förbehåll för undantag (t.ex. faktureringsposter som vi måste bevara).',
      ],
    },
    {
      title: '7. Säkerhet',
      paragraphs: [
        'Vi använder administrativa, tekniska och organisatoriska åtgärder utformade för att skydda information. Ingen metod för överföring eller lagring är 100 % säker; vi kan inte garantera absolut säkerhet.',
      ],
    },
    {
      title: '8. Dina rättigheter och val',
      paragraphs: [
        'Beroende på var du befinner dig kan du ha rätt att få tillgång till, rätta, radera, begränsa eller portera dina personuppgifter samt invända mot viss behandling. Du kan uppdatera profilinställningar i appen och hantera cookieinställningar via vår cookiebanner.',
        'För att utöva integritetsrättigheter, kontakta legal@tscopier.ai. Vi kan verifiera din identitet innan vi svarar. Du kan också lämna in klagomål till din lokala dataskyddsmyndighet.',
      ],
    },
    {
      title: '9. Barn',
      paragraphs: [
        'Tjänsten riktar sig inte till barn under 18 år. Vi samlar inte medvetet in personuppgifter från barn. Kontakta oss om du tror att ett barn har lämnat uppgifter så raderar vi dem.',
      ],
    },
    {
      title: '10. Ändringar',
      paragraphs: [
        'Vi kan uppdatera denna Integritetspolicy från tid till annan. Vi publicerar den reviderade policyn med ett nytt datum för "Senast uppdaterad" och lämnar ytterligare information när det krävs.',
      ],
    },
  ],
  closing:
    'För integritetsfrågor eller begäranden, kontakta legal@tscopier.ai.',
  contact: legalContactSv,
}
