import type { ContactSupportPageTranslations } from './types'

export const contactSupportNl: ContactSupportPageTranslations = {
  channelsTitle: 'Hoe kunnen we je helpen?',
  channelsSubtitle: 'Neem contact op met het TScopier-team via e-mail, bekijk de documentatie of start een livechat.',
  email: {
    title: 'E-mailondersteuning',
    description: 'Stuur vragen over account, facturatie of copier - we reageren meestal binnen een werkdag.',
    cta: 'Support e-mailen',
  },
  docs: {
    title: 'Documentatie',
    description: 'Stapsgewijze handleidingen voor het koppelen van brokers, Telegram-kanalen, handelsstijlen en probleemoplossing.',
    cta: 'Documentatie openen',
  },
  liveChat: {
    title: 'Livechat',
    description: 'Chat in realtime met ons voor snelle hulp bij de setup terwijl je in het dashboard werkt.',
    cta: 'Livechat starten',
  },
  faq: {
    title: 'Veelgestelde vragen',
    subtitle: 'Snelle antwoorden voordat je contact opneemt.',
    items: [
      {
        question: 'Hoe koppel ik mijn MetaTrader-account?',
        answer:
          'Open Configuratie, voeg een brokeraccount toe, voer je MetaTrader-inloggegevens in en wacht tot de verbindingsstatus op verbonden staat. Voor elk gekoppeld account moeten handelsstijl, lotgrootte en kanaalselectie zijn opgeslagen voordat het kopiëren start.',
      },
      {
        question: 'Waarom worden mijn Telegram-signalen niet gekopieerd?',
        answer:
          'Controleer of je broker is verbonden, het Telegram-kanaal is gekoppeld en actief is, het kanaal bij de broker in Configuratie is geselecteerd, je abonnement actief is en je e-mailadres is geverifieerd. Controleer Copier Logs op redenen voor overslaan, zoals kanaalfilters, nieuwsblackout of ontbrekende SL/TP in het signaal.',
      },
      {
        question: 'Hoe voeg ik een Telegram-signaalkanaal toe?',
        answer:
          'Ga naar Kanalen, koppel Telegram indien nodig en voeg daarna de kanaalgebruikersnaam of uitnodigingslink toe. Activeer het kanaal en wijs het in Configuratie toe aan de brokeraccounts die de signalen moeten kopiëren.',
      },
      {
        question: 'Wat doet nieuwshandel / economische-kalender-blackout?',
        answer:
          'Wanneer nieuwshandel op een account is uitgeschakeld, kan TScopier nieuwe posities pauzeren en optioneel open transacties sluiten rond kalendergebeurtenissen met hoge impact. Gebruik de pagina Economische kalender om komende publicaties te zien en regels in te stellen onder Accountconfiguratie.',
      },
      {
        question: 'Heb ik een betaald abonnement nodig om transacties te kopiëren?',
        answer:
          'Een actief betaald plan is vereist voor live uitvoering van de Telegram-copier. Je kunt het dashboard en de configuratie nog steeds verkennen in een beschikbare proefperiode; controleer Facturatie voor je huidige plan en verlengingsstatus.',
      },
      {
        question: 'Waarom moet ik mijn e-mailadres verifiëren voordat ik het platform gebruik?',
        answer:
          'E-mailverificatie bevestigt je login en stelt ons in staat factuurbewijzen en belangrijke accountmeldingen te sturen. Als je vastloopt op het verificatiescherm, gebruik dan de link om opnieuw te verzenden of neem contact op met support met het adres waarmee je je hebt geregistreerd.',
      },
      {
        question: 'Mijn broker staat als niet verbonden - wat kan ik proberen?',
        answer:
          'Controleer of MetaTrader aan de brokerkant draait, je inloggegevens nog geldig zijn en het account niet is vergrendeld. Vernieuw vanuit Configuratie en controleer daarna Copier Logs op sessiefouten. Als het probleem aanhoudt, mail support met je brokernaam en accountlogin (nooit je wachtwoord).',
      },
      {
        question: 'Kan ik hetzelfde kanaal naar meerdere brokers kopiëren?',
        answer:
          'Ja. Koppel elk MetaTrader-account afzonderlijk in Configuratie en selecteer hetzelfde Telegram-kanaal voor elke broker. Lotgrootte, handelsstijl en risicoinstellingen worden per account ingesteld.',
      },
    ],
  },
}
