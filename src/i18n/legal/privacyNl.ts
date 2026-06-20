import type { LegalDocumentPageTranslations } from './types'
import { legalContactNl } from './contactNl'

export const privacyPolicyNl: LegalDocumentPageTranslations = {
  title: 'Privacybeleid',
  lastUpdated: 'Laatst bijgewerkt: 8 juni 2026',
  intro:
    'Tartarix, Inc. ("Tartarix", "wij", "ons" of "onze") respecteert uw privacy. Dit Privacybeleid legt uit hoe wij informatie verzamelen, gebruiken, delen en beschermen wanneer u de websites en applicaties van TScopier gebruikt (de "Dienst").',
  sections: [
    {
      title: '1. Informatie die wij verzamelen',
      paragraphs: [
        'Accountinformatie: naam, e-mailadres, wachtwoordhash, taal- en profielvoorkeuren, abonnementsstatus en verwijzingscodes.',
        'Broker- en handelsconfiguratie: brokerlabels, accountlogins (wachtwoorden worden niet als platte tekst opgeslagen), platformtype, kanaalkeuzes, copier-instellingen en uitvoeringslogs die nodig zijn om de Dienst te laten werken.',
        'Handels- en signaalgegevens: Telegram-kanaal-ID\'s, geparseerde signaalinhoud, transactiegegevens, redenen voor overslaan en prestatiemetrieken die aan uw account zijn gekoppeld.',
        'Betalingsinformatie: factureringsstatus en klant-ID\'s van onze betalingsverwerker. Kaartgegevens worden verwerkt door de verwerker en niet door ons opgeslagen.',
        'Technische gegevens: IP-adres, browsertype, apparaatinformatie, cookies, analytics-identificatoren en gebruiksgebeurtenissen (zie ons Cookiebeleid).',
        'Communicatie: berichten die u stuurt naar support-, juridische- of geschillen-e-mailadressen.',
      ],
    },
    {
      title: '2. Hoe wij informatie gebruiken',
      paragraphs: [
        'De Dienst leveren, onderhouden en verbeteren; gebruikers authenticeren; abonnementen verwerken; geconfigureerde copy-tradingworkflows uitvoeren; dashboards en logs tonen.',
        'Transactionele e-mails verzenden (verificatie, facturering, beveiligingsmeldingen) en reageren op supportverzoeken.',
        'Betrouwbaarheid monitoren, fraude en misbruik voorkomen, onze Voorwaarden handhaven en voldoen aan wettelijke verplichtingen.',
        'Geaggregeerd gebruik analyseren om productfuncties te verbeteren (met inachtneming van uw cookiekeuzes waar van toepassing).',
      ],
    },
    {
      title: '3. Rechtsgronden (gebruikers in EER/VK)',
      paragraphs: [
        'Waar de AVG of vergelijkbare wetgeving van toepassing is, verwerken wij persoonsgegevens op basis van: uitvoering van een overeenkomst (levering van de Dienst), gerechtvaardigd belang (beveiliging, analytics, productverbetering), toestemming (niet-essentiële cookies/marketing waar vereist) en wettelijke verplichting.',
      ],
    },
    {
      title: '4. Hoe wij informatie delen',
      paragraphs: [
        'Dienstverleners: hosting en database (bijv. Supabase), betalingsverwerking (bijv. Stripe), e-maillevering, analytics (bijv. Google Analytics na toestemming), brokerconnectiviteits-API\'s en klantenservicetools — alleen voor zover nodig om de Dienst te leveren.',
        'Wij verkopen uw persoonsgegevens niet. Wij kunnen informatie openbaar maken als dit wettelijk verplicht is, om rechten en veiligheid te beschermen, of in verband met een fusie, overname of verkoop van activa met passende waarborgen.',
      ],
    },
    {
      title: '5. Internationale doorgiften',
      paragraphs: [
        'Wij kunnen informatie verwerken en opslaan in de Verenigde Staten en andere landen waar wij of onze dienstverleners actief zijn. Waar wettelijk vereist gebruiken wij passende waarborgen voor grensoverschrijdende doorgiften.',
      ],
    },
    {
      title: '6. Bewaartermijn',
      paragraphs: [
        'Wij bewaren informatie zolang uw account actief is en zolang nodig is om de Dienst te leveren, geschillen op te lossen, overeenkomsten af te dwingen en aan wettelijke vereisten te voldoen. U kunt verwijdering verzoeken, onder voorbehoud van uitzonderingen (bijv. factureringsgegevens die wij moeten bewaren).',
      ],
    },
    {
      title: '7. Beveiliging',
      paragraphs: [
        'Wij gebruiken administratieve, technische en organisatorische maatregelen om informatie te beschermen. Geen enkele overdrachts- of opslagmethode is 100% veilig; wij kunnen absolute beveiliging niet garanderen.',
      ],
    },
    {
      title: '8. Uw rechten en keuzes',
      paragraphs: [
        'Afhankelijk van uw locatie heeft u mogelijk rechten op inzage, correctie, verwijdering, beperking of overdraagbaarheid van uw persoonsgegevens en het recht om bezwaar te maken tegen bepaalde verwerkingen. U kunt profielinstellingen in de app bijwerken en cookievoorkeuren beheren via onze cookiebanner.',
        'Om privacyrechten uit te oefenen, neem contact op via legal@tscopier.ai. Wij kunnen uw identiteit verifiëren voordat wij reageren. U kunt ook een klacht indienen bij uw lokale toezichthouder voor gegevensbescherming.',
      ],
    },
    {
      title: '9. Kinderen',
      paragraphs: [
        'De Dienst is niet gericht op kinderen jonger dan 18 jaar. Wij verzamelen niet bewust persoonsgegevens van kinderen. Neem contact op als u denkt dat een kind gegevens heeft verstrekt; dan verwijderen wij deze.',
      ],
    },
    {
      title: '10. Wijzigingen',
      paragraphs: [
        'Wij kunnen dit Privacybeleid van tijd tot tijd bijwerken. Wij publiceren het herziene beleid met een nieuwe datum "Laatst bijgewerkt" en geven waar nodig aanvullende kennisgeving.',
      ],
    },
  ],
  closing:
    'Voor privacyvragen of verzoeken kunt u contact opnemen via legal@tscopier.ai.',
  contact: legalContactNl,
}
