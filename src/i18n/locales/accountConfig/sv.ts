import { configureModalSv } from '../configureModal/sv'
import type { AccountConfigBundleTranslations } from './types'

export const accountConfigSv: AccountConfigBundleTranslations = {
  accountConfig: {
    brokersEmptyTitle: 'Inga konton är anslutna ännu',
    brokersEmptySubtitle: 'Lägg till ditt handelskonto för att komma igång',
    addAccount: {
      title: 'Lägg till ett handelskonto',
      subtitle: 'Välj din föredragna handelsplattform för att komma igång',
      footerHint: 'Fler plattformar kommer snart',
      comingSoonBadge: 'Kommer snart',
      comingSoonPlatform: 'Integration med {platform} kommer snart. Välj MT4 eller MT5 tills vidare.',
    },
    connectForm: {
      addAccountButton: 'Lägg till konto',
      title: 'Anslut ett nytt {platform}-konto',
      accountLabel: 'Kontonamn (valfritt)',
      accountLabelPlaceholder: 't.ex. Live {platform}',
      platformLabel: 'Plattform',
      platformMt5: 'MetaTrader 5 (MT5)',
      platformMt4: 'MetaTrader 4 (MT4)',
      brokerServerLabel: 'Mäklarserver',
      brokerServerHint:
        'Klistra in det exakta servernamnet från din MetaTrader-terminal (Fil → Logga in på handelskonto).',
      brokerServerPlaceholder: 't.ex. ICMarketsSC-MT5',
      brokerCompanySearchPlaceholder: 'Sök på mäklarföretag eller servernamn',
      brokerCompanySearchServersHeading: 'Servrar',
      brokerCompanySearchCompaniesHeading: 'Mäklare',
      brokerCompanySearchEmpty: 'Sök efter ditt mäklarföretag eller servernamn',
      brokerCompanySearchMinChars: 'Skriv minst 4 tecken för att söka',
      brokerCompanySearchNoResults: 'Inga träffar i vår mäklarkatalog.',
      brokerCompanySearchUseQuery: 'Använd "{query}" som servernamn',
      brokerCompanySearchLoading: 'Söker efter mäklare…',
      brokerCompanySearchError: 'Mäklar­sökningen misslyckades. Försök igen eller ange servern manuellt.',
      brokerServerPickerTitle: 'Server',
      brokerServerSelectPrompt: 'Sök efter din mäklares företag',
      brokerServerManualToggle: 'Hittar du inte din mäklare? Ange server manuellt',
      brokerServerManualLabel: 'Servernamn',
      brokerServerManualHint: 'Använd det exakta servernamnet från din MT-terminal.',
      mtLoginLabel: 'MT-inloggning',
      mtLoginPlaceholder: 'Handelskontonummer',
      passwordLabel: 'Lösenord',
      passwordPlaceholder: 'Lösenord för handelskonto',
      passwordHint: '',
      rememberPasswordLabel: 'Kom ihåg lösenord för automatisk återanslutning',
      rememberPasswordHint:
        'Krypterar ditt MT-lösenord på våra servrar så att TScopier kan återställa sessionen utan att fråga igen. Du kan ta bort det när som helst.',
      connectButton: 'Anslut konto',
      connectingTitle: 'Ansluter din mäklare',
      connectingStepLinking: 'Länkar ditt {platform}-konto…',
      connectingStepTerminal: 'Startar din {platform}-terminal — detta tar vanligtvis 10–30 sekunder.',
      connectingStepSlow: 'Arbetar fortfarande… första uppsättningen kan ta några minuter.',
      validationRequired: 'Kontonummer, lösenord och server krävs',
      connectFailed: 'Det gick inte att ansluta kontot',
      addMoreButton: 'Lägg till fler',
      removeRowAria: 'Ta bort kontorad',
      connectMultipleButton: 'Anslut {count} konton',
      uploadAccountsButton: 'Ladda upp konton',
      accountRowTitle: 'Konto {index}',
    },
    bulkConnect: {
      title: 'Ladda upp MT4/MT5-konton',
      securityNote:
        'Din CSV innehåller handelslösenord. Den tolkas endast i din webbläsare och laddas aldrig upp som fil.',
      downloadTemplate: 'Ladda ner CSV-mall',
      uploadCsv: 'Ladda upp CSV',
      uploadHint: 'Släpp en CSV-fil här eller klicka för att bläddra. Använd platform-kolumnen (MT4 eller MT5) per rad — standard MT5 om den saknas.',
      previewTitle: 'Förhandsvisning',
      colLabel: 'Namn',
      colPlatform: 'Plattform',
      colServer: 'Server',
      colLogin: 'Inloggning',
      colPassword: 'Lösenord',
      colStatus: 'Status',
      parseErrorLine: 'Rad {line}: {message}',
      noValidRows: 'Inga giltiga konton hittades i CSV-filen.',
      connectCount: 'Anslut {count} konton',
      connectingTitle: 'Länkar konton…',
      statusQueued: 'I kö',
      statusLinking: 'Länkar…',
      statusLinked: 'Länkad',
      statusFailed: 'Misslyckades',
      statusSkippedDuplicate: 'Dubblett',
      statusSkippedLimit: 'Gräns nådd',
      statusSkippedInvalid: 'Ogiltig',
      summaryTitle: 'Konton länkade',
      summaryBody: '{linked} länkade, {failed} misslyckades, {skipped} hoppades över.',
      summaryFailedTitle: 'Misslyckade konton',
      dismiss: 'Stäng',
      viewBrokers: 'Visa mäklare',
    },
    brokerList: {
      statusPaused: 'Pausad',
      statusConnected: 'Ansluten',
      statusConnecting: 'Ansluter',
      statusRecovering: 'Återansluter',
      statusError: 'Fel',
      statusDisconnected: 'Frånkopplad',
      copyTrades: 'Kopiera affärer',
      reconnect: 'Återanslut',
      reconnectAll: 'Återanslut alla',
      configure: 'Konfigurera',
      removeAria: 'Ta bort {label}',
      detailLogin: 'Inloggning',
      detailAccountType: 'Kontotyp',
      accountTypeDemo: 'Demo',
      accountTypeLive: 'Live',
      accountTypePropFirm: 'Prop firm',
      detailServer: 'Server',
      detailSignalChannels: 'Signalkanaler',
      detailBalance: 'Saldo',
      detailEquity: 'Eget kapital',
      channelsNoneSelected: 'Inga valda',
      channelsEmptySaveWarning:
        'Inga signalkanaler valda — den här mäklaren kommer inte att kopiera några Telegram-signaler. Spara ändå?',
      channelsSaveChannelListNotReady:
        'Kanallistan laddas fortfarande. Vänta en stund och försök spara igen.',
      channelsSaveLinkedChannelsInvalid:
        'Länkade signalkanaler kunde inte sparas. Uppdatera sidan och försök igen.',
      channelsSignalChannel: 'Signalkanal',
      channelsAll: 'Alla signalkanaler',
      relinkOne:
        'Detta konto använder ett äldre länkningsformat. Ta bort det och anslut igen med din MT-inloggning och ditt lösenord.',
      relinkMany:
        '{count} konton använder ett äldre länkningsformat. Ta bort varje konto och anslut igen med din MT-inloggning och ditt lösenord.',
      reconnectDroppedOne:
        'Handelssessionen löpte ut på handelsservern. Använd Återanslut och ange ditt aktuella MT-lösenord.',
      reconnectDroppedMany:
        '{count} konton förlorade anslutningen till mäklaren och visas som Frånkopplad. Använd Återanslut på varje konto.',
      connectErrorWrongPassword:
        'MT-kontots lösenord är fel. Kontrollera lösenordet i din MetaTrader-terminal och försök igen.',
      connectErrorWrongLogin:
        'MT-inloggningsnumret matchar inte denna mäklarserver. Verifiera kontonumret i MetaTrader.',
      connectErrorWrongServer:
        'Mäklarserverns namn är felaktigt eller matchar inte denna inloggning. Kontrollera exakt servernamn i MetaTrader.',
      connectErrorInvestorPassword:
        'Ett investerarlösenord (skrivskyddat) användes. Anslut med det primära handelslösenordet från MetaTrader.',
      connectErrorAccountDisabled:
        'Detta MT-konto är inaktiverat eller spärrat hos mäklaren. Kontakta mäklaren eller logga in via MetaTrader först.',
      connectErrorCredentialsRejected:
        'Det gick inte att logga in med dessa MT-uppgifter. Verifiera kontonummer, handelslösenord och exakt servernamn från MetaTrader.',
      connectErrorTerminalNotReady:
        'Vi kunde inte ladda ditt konto från mäklaren ännu. Om du precis anslöt, vänta en minut och försök igen. Annars, verifiera att MT-inloggning, lösenord och server stämmer exakt med MetaTrader.',
      connectErrorSessionExpired:
        'Handelssessionen löpte ut på handelsservern. Använd Återanslut och ange ditt aktuella MT-lösenord.',
      connectErrorUnknown:
        'Mäklaranslutningen misslyckades. Kontrollera dina MT-uppgifter eller använd Återanslut om kontot varit länkat tidigare.',
      reconnectFailed: 'Det gick inte att återansluta mäklaren',
      reconnectPasswordTitle: 'Mäklarsessionen har löpt ut',
      reconnectPasswordBody:
        'Din mäklarsession har löpt ut på handelsservern. Ange lösenordet för ditt MT-konto för att återansluta.',
      reconnectPasswordLabel: 'Lösenord för MT-konto',
      reconnectPasswordHint:
        'Skickas endast till MT-servrar. Aktivera kom ihåg nedan för att spara det krypterat för automatisk återanslutning.',
      reconnectPasswordPlaceholder: 'Lösenord för handelskonto',
      rememberPasswordLabel: 'Kom ihåg lösenord för automatisk återanslutning',
      rememberPasswordHint:
        'Lagrar en krypterad kopia så att TScopier kan återansluta utan att fråga igen. Du kan rensa den i Kontokonfiguration.',
      clearStoredCredentials: 'Glöm sparat lösenord',
      storedCredentialsActive: 'Automatisk återanslutning aktiverad',
      deleteFailed: 'Det gick inte att ta bort mäklaren',
      deleteSessionExpired:
        'Din inloggningssession har löpt ut. Uppdatera sidan och försök igen, eller logga ut och in igen.',
      duplicateMtLogin:
        'Denna MT-inloggning är redan länkad till ett annat konto här. Ta bort det först eller använd Återanslut — samma inloggning kan inte anslutas två gånger.',
      platformServerMismatchMt4:
        'Detta servernamn verkar vara MT4, men du valde MT5. Kopiering och handelshantering kan misslyckas. Ansluta som MT4 i stället?',
      platformServerMismatchMt5:
        'Detta servernamn verkar vara MT5, men du valde MT4. Kopiering och handelshantering kan misslyckas. Ansluta som MT5 i stället?',
      deleteTitle: 'Ta bort handelskonto?',
      deleteBody: 'Detta kopplar bort {label} från din mäklare och kopieraren. Detta kan inte ångras.',
      deleteConfirm: 'Koppla från',
      connectedAccountsHeading: 'Anslutna konton',
      connectedAccountsUnlimited: 'Obegränsat',
      brokerFilterLabel: 'Mäklare',
      brokerFilterAll: 'Alla mäklare',
      brokerFilterNoMatch: 'Inga konton matchar denna mäklare.',
      accountSearchLabel: 'Sök konton',
      accountSearchPlaceholder: 'Namn, inloggning, server, mäklare…',
      accountSearchNoMatch: 'Inga konton matchar din sökning.',
    },
    brokerConnectedSuccess: {
      title: 'Mäklare ansluten',
      titlePending: 'Mäklare länkad',
      body: '{account} är anslutet och klart att kopiera signaler.',
      bodyPending:
        '{account} är länkat. Din MT5-terminal startar — du kan konfigurera kanaler medan anslutningen pågår.',
      addChannel: 'Lägg till kanal',
      configure: 'Konfigurera',
    },
    configureModal: configureModalSv,
  },
}
