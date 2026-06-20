import type { RiskDisclaimerPageTranslations } from './types'

export const riskDisclaimerSv: RiskDisclaimerPageTranslations = {
  title: 'Riskvarning',
  intro:
    'Handel med valuta, CFD:er och andra belånade produkter innebär en betydande risk för förlust. TScopier är ett verktyg för kopiering av affärer — inte en mäklare, investeringsrådgivare eller finansiell planerare. Ingenting på denna sida utgör finansiell rådgivning. Du är ensam ansvarig för dina handelsbeslut och eventuella förluster.',
  sections: [
    {
      title: 'Allmän handelsrisk',
      paragraphs: [
        'Du kan förlora delar av eller hela ditt insatta kapital. Hävstång förstorar både vinster och förluster. Tidigare resultat för en signalleverantör, ett backtest eller din egen historik garanterar inte framtida resultat.',
        'Marknader kan gappa, stoppas eller röra sig kraftigt vid nyhetshändelser. TScopier garanterar inte att signaler tas emot, tolkas eller exekveras till ett visst pris eller vid en viss tidpunkt.',
      ],
    },
    {
      title: 'Risk hos signalleverantör',
      paragraphs: [
        'Kopiera endast signalleverantörer som du litar på och förstår. Leverantörer kan ha incitament som strider mot dina intressen. Marknadsföringsbilder, påståenden om vinstfrekvens och selekterade resultat kanske inte speglar vad du upplever på ditt konto, med din lotstorlek, din mäklare eller din latens.',
        'Verifiera resultat oberoende när det är möjligt. En leverantör som fungerar för andra kan ändå vara olämplig för din risktolerans, kontostorlek eller handelstider.',
      ],
    },
    {
      title: 'Repainting och kanalmanipulation',
      paragraphs: [
        'Vissa Telegram-kanaler för signaler redigerar eller tar bort meddelanden efter en misslyckad affär så att den publika feeden ser felfri ut. En "lyckad" signal kan ha skrivits om, och en förlorande signal kan försvinna helt.',
        'Förlita dig inte enbart på kanalens synliga historik eller skärmbilder från tredje part. Jämför med dina egna Copier Logs, mäklarutdrag och tidsstämplade poster. Repainting gör det lätt för leverantörer att framstå som mer precisa än de faktiskt är.',
      ],
    },
    {
      title: 'Begränsningar i tolkning och exekvering',
      paragraphs: [
        'Signaler tolkas automatiskt från text. Skrivfel i stop loss (SL) eller take profit (TP) — fel siffror, saknade decimaler, tvetydiga symboler eller blandade enheter — kan ge ogiltiga priser. TScopier kan hoppa över signalen, ignorera ogiltiga nivåer eller använda standardvärden från din konfiguration i stället för leverantörens avsikt.',
        'Exekveringen kan skilja sig från leverantörens ingång: slippage, requotes, partiella fyllningar, regler om minsta avstånd och avbrutna brokersessioner påverkar utfallet. Strict entry, range pending och multi-leg-stilar ökar komplexiteten ytterligare. Kontrollera alltid öppna positioner hos din mäklare.',
      ],
    },
    {
      title: 'Operativa risker och konfigurationsrisker',
      paragraphs: [
        'Nyhetsblackouts, kanalfilter, vinstmål, maxförlustgränser, prenumerationsstatus och inställningar per kanal kan blockera eller ändra kopieringen. Felkonfigurerad lotstorlek, symbolmappning eller ej länkade kanaler är vanliga orsaker till att affärer inte kopieras som förväntat.',
        'Automatisk stängning när gränser uppnås stänger kanalattribuerade affärer på TScopiers sida, men kan inte återställa en marknadsförlust som redan uppstått. Konfigurationsändringar gäller efter att de sparats — osparade utkast skyddar inte ditt konto.',
      ],
    },
    {
      title: 'Var aktiv under kopiering',
      paragraphs: [
        'Automatisk kopiering är inte "ställ in och glöm". Övervaka öppna affärer, equity, margin och Copier Logs regelbundet. Ingrip hos din mäklare när förhållanden ändras eller när du inte längre accepterar leverantörens exponering.',
        'Om du inte kan övervaka ditt konto aktivt kan kopiering av livesignaler vara olämpligt för dig.',
      ],
    },
    {
      title: 'Förbättra dina chanser (inte rådgivning)',
      paragraphs: [
        'Börja med ett demokonto eller minsta möjliga live-storlek som du har råd att förlora. Utvärdera kanaler över tid; använd backtester där det finns; aktivera maxförlust och vinstmål; finjustera kanalfilter; diversifiera mellan leverantörer i stället för att koncentrera risken.',
        'Läs orsaker till att signaler hoppas över i Copier Logs när affärer inte tas. Ha realistiska förväntningar — konsekventa små fördelar med strikt riskkontroll är något helt annat än marknadsföring om att "bli rik snabbt".',
      ],
    },
  ],
  closing:
    'Genom att använda TScopier bekräftar du att handel är riskfylld, att signalleverantörer kan vara opålitliga eller vilseledande, och att du accepterar fullt ansvar för alla affärer som placeras på dina länkade konton.',
}
