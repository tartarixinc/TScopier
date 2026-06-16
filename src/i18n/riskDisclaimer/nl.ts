import type { RiskDisclaimerPageTranslations } from './types'

export const riskDisclaimerNl: RiskDisclaimerPageTranslations = {
  title: 'Risicowaarschuwing',
  intro:
    'Handelen in forex, CFD\'s en andere producten met hefboomwerking brengt een aanzienlijk risico op verlies met zich mee. TSCopier is een tool voor het kopieren van transacties — geen broker, beleggingsadviseur of financieel planner. Niets op deze pagina is financieel advies. U bent zelf volledig verantwoordelijk voor uw handelsbeslissingen en eventuele verliezen.',
  sections: [
    {
      title: 'Algemeen handelsrisico',
      paragraphs: [
        'U kunt een deel of al uw ingelegde kapitaal verliezen. Hefboomwerking vergroot zowel winsten als verliezen. Eerdere prestaties van een signaalaanbieder, backtest of uw eigen historie bieden geen garantie voor toekomstige resultaten.',
        'Markten kunnen met gaps openen, stilvallen of extreem bewegen tijdens nieuwsgebeurtenissen. TSCopier garandeert niet dat signalen op een bepaald moment of tegen een bepaalde prijs worden ontvangen, geparseerd of uitgevoerd.',
      ],
    },
    {
      title: 'Risico van signaalaanbieders',
      paragraphs: [
        'Kopieer alleen signaalaanbieders die u vertrouwt en begrijpt. Aanbieders kunnen prikkels hebben die botsen met uw belangen. Marketing-screenshots, claims over winrates en geselecteerde resultaten weerspiegelen mogelijk niet wat u ervaart op uw account, met uw lotgrootte, broker of latency.',
        'Controleer prestaties waar mogelijk onafhankelijk. Een aanbieder die voor anderen werkt, kan nog steeds ongeschikt zijn voor uw risicotolerantie, accountgrootte of handelstijden.',
      ],
    },
    {
      title: 'Repainting en kanaalmanipulatie',
      paragraphs: [
        'Sommige Telegram-signaalkanalen bewerken of verwijderen berichten nadat een trade misgaat, zodat de publieke feed foutloos lijkt. Een "succesvolle" call kan zijn aangepast; een verliezende call kan volledig verdwijnen.',
        'Vertrouw niet alleen op de zichtbare kanaalgeschiedenis of screenshots van derden. Vergelijk met uw eigen Copier Logs, brokerafschriften en records met tijdstempel. Repainting maakt het voor aanbieders eenvoudig om nauwkeuriger te lijken dan ze in werkelijkheid zijn.',
      ],
    },
    {
      title: 'Beperkingen in parsing en uitvoering',
      paragraphs: [
        'Signalen worden automatisch uit tekst geinterpreteerd. Typefouten in stop loss (SL) of take profit (TP) — verkeerde cijfers, ontbrekende decimalen, dubbelzinnige symbolen of gemengde eenheden — kunnen ongeldige prijzen veroorzaken. TSCopier kan het signaal overslaan, ongeldige niveaus negeren of standaardwaarden uit uw configuratie toepassen in plaats van de bedoeling van de aanbieder.',
        'De uitvoering kan afwijken van de entry van de aanbieder: slippage, requotes, gedeeltelijke fills, regels voor minimale afstand en verbroken brokersessies beinvloeden de uitkomst. Strict entry-, range pending- en multi-leg-stijlen voegen extra complexiteit toe. Controleer open posities altijd bij uw broker.',
      ],
    },
    {
      title: 'Operationele en configuratierisico\'s',
      paragraphs: [
        'Nieuwsblack-outs, kanaalfilters, winstdoelen, limieten voor maximaal verlies, abonnementsstatus en instellingen per kanaal kunnen kopieren blokkeren of wijzigen. Verkeerd ingestelde lotgrootte, symboolmapping of niet-gekoppelde kanalen zijn veelvoorkomende redenen waarom trades niet worden gekopieerd zoals verwacht.',
        'Automatisch sluiten wanneer limieten worden geraakt, sluit kanaaltoegeschreven trades aan de TSCopier-kant, maar kan reeds geleden marktverlies niet ongedaan maken. Configuratiewijzigingen worden pas actief na opslaan — niet-opgeslagen concepten beschermen uw account niet.',
      ],
    },
    {
      title: 'Blijf betrokken tijdens kopieren',
      paragraphs: [
        'Automatisch kopieren is geen "instellen en vergeten". Controleer open trades, equity, margin en Copier Logs regelmatig. Grijp in bij uw broker wanneer omstandigheden veranderen of wanneer u het niet langer eens bent met de blootstelling van de aanbieder.',
        'Als u uw account niet actief kunt monitoren, kan het kopieren van live signalen ongeschikt voor u zijn.',
      ],
    },
    {
      title: 'Uw kansen verbeteren (geen advies)',
      paragraphs: [
        'Begin met een demo-account of met de kleinste live omvang die u zich kunt veroorloven te verliezen. Beoordeel kanalen over langere tijd; gebruik backtests waar beschikbaar; activeer limieten voor maximaal verlies en winstdoelen; verfijn kanaalfilters; spreid over aanbieders in plaats van risico te concentreren.',
        'Lees de skip-redenen in Copier Logs wanneer signalen niet worden verhandeld. Houd realistische verwachtingen — consistente kleine voordelen met strikte risicocontrole verschillen sterk van "snel rijk worden"-marketing.',
      ],
    },
  ],
  closing:
    'Door TSCopier te gebruiken erkent u dat handelen risicovol is, dat signaalaanbieders onbetrouwbaar of misleidend kunnen zijn, en dat u de volledige verantwoordelijkheid aanvaardt voor alle trades die op uw gekoppelde accounts worden geplaatst.',
}
