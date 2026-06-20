import type { ContactSupportPageTranslations } from './types'

export const contactSupportSv: ContactSupportPageTranslations = {
  channelsTitle: 'Hur kan vi hjälpa dig?',
  channelsSubtitle: 'Kontakta TScopier-teamet via e-post, läs dokumentationen eller starta en livechatt.',
  email: {
    title: 'Support via e-post',
    description: 'Skicka frågor om konto, fakturering eller copier - vi svarar vanligtvis inom en arbetsdag.',
    cta: 'Skicka e-post',
  },
  docs: {
    title: 'Dokumentation',
    description: 'Steg-för-steg-guider för att koppla mäklare, Telegram-kanaler, handelsstilar och felsökning.',
    cta: 'Öppna dokumentation',
  },
  liveChat: {
    title: 'Livechatt',
    description: 'Chatta med oss i realtid för snabb installationshjälp medan du är i instrumentpanelen.',
    cta: 'Starta livechatt',
  },
  faq: {
    title: 'Vanliga frågor',
    subtitle: 'Snabba svar innan du kontaktar oss.',
    items: [
      {
        question: 'Hur kopplar jag mitt MetaTrader-konto?',
        answer:
          'Öppna Konfiguration, lägg till ett mäklarkonto, ange dina MetaTrader-inloggningsuppgifter och vänta tills anslutningsstatus visar ansluten. Varje länkat konto måste ha handelsstil, lotstorlek och kanalval sparat innan kopieringen startar.',
      },
      {
        question: 'Varför kopieras inte mina Telegram-signaler?',
        answer:
          'Kontrollera att mäklaren är ansluten, att Telegram-kanalen är länkad och aktiv, att kanalen är vald på mäklaren i Konfiguration, att din prenumeration är aktiv och att din e-post är verifierad. Granska Copier Logs för orsaker till att signaler hoppas över, till exempel kanalfilter, nyhetsblockering eller saknad SL/TP i signalen.',
      },
      {
        question: 'Hur lägger jag till en Telegram-signal-kanal?',
        answer:
          'Gå till Kanaler, anslut Telegram vid behov och lägg sedan till kanalens användarnamn eller inbjudningslänk. Aktivera kanalen och tilldela den till de mäklarkonton som ska kopiera signalerna i Konfiguration.',
      },
      {
        question: 'Vad gör nyhetshandel / blackout i ekonomisk kalender?',
        answer:
          'När nyhetshandel är inaktiverad på ett konto kan TScopier pausa nya positioner och valfritt stänga öppna affärer runt kalenderhändelser med hög påverkan. Använd sidan Ekonomisk kalender för att se kommande publiceringar och konfigurera regler under Kontokonfiguration.',
      },
      {
        question: 'Behövs en betald prenumeration för att kopiera affärer?',
        answer:
          'En aktiv betald plan krävs för livekörning av Telegram-copier. Du kan fortfarande utforska instrumentpanelen och konfigurationen under en tillgänglig testperiod; kontrollera Fakturering för aktuell plan och förnyelsestatus.',
      },
      {
        question: 'Varför måste jag verifiera min e-post innan jag använder plattformen?',
        answer:
          'E-postverifiering bekräftar din inloggning och gör att vi kan skicka kvitton och viktiga kontovarningar. Om du fastnar på verifieringsskärmen kan du använda länken för att skicka om eller kontakta support med adressen du registrerade dig med.',
      },
      {
        question: 'Min mäklare visas som frånkopplad - vad ska jag prova?',
        answer:
          'Bekräfta att MetaTrader kör hos din mäklare, att inloggningsuppgifterna fortfarande är giltiga och att kontot inte är låst. Uppdatera från Konfiguration och kontrollera sedan Copier Logs för sessionsfel. Om problemet kvarstår, mejla support och ange mäklarens namn och kontologin (aldrig ditt lösenord).',
      },
      {
        question: 'Kan jag kopiera samma kanal till flera maklare?',
        answer:
          'Ja. Länka varje MetaTrader-konto separat i Konfiguration och välj samma Telegram-kanal för varje mäklare. Lotstorlek, handelsstil och riskinställningar anges per konto.',
      },
    ],
  },
}
