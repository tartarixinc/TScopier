import { configureModalPl } from '../configureModal/pl'
import type { AccountConfigBundleTranslations } from './types'

export const accountConfigPl: AccountConfigBundleTranslations = {
  accountConfig: {
    brokersEmptyTitle: 'Nie połączono jeszcze żadnych kont',
    brokersEmptySubtitle: 'Dodaj swoje konto tradingowe, aby rozpocząć',
    addAccount: {
      title: 'Dodaj konto tradingowe',
      subtitle: 'Wybierz preferowaną platformę tradingową, aby rozpocząć',
      footerHint: 'Wkrótce kolejne platformy',
      comingSoonBadge: 'Wkrótce',
      comingSoonPlatform: 'Integracja z {platform} będzie dostępna wkrótce. Na razie wybierz MT4 lub MT5.',
    },
    connectForm: {
      addAccountButton: 'Dodaj konto',
      title: 'Połącz nowe konto {platform}',
      accountLabel: 'Etykieta konta (opcjonalnie)',
      accountLabelPlaceholder: 'np. Live {platform}',
      platformLabel: 'Platforma',
      platformMt5: 'MetaTrader 5 (MT5)',
      platformMt4: 'MetaTrader 4 (MT4)',
      brokerServerLabel: 'Serwer brokera',
      brokerServerHint:
        'Wklej dokładną nazwę serwera z terminala MetaTrader (Plik → Zaloguj się do rachunku handlowego).',
      brokerServerPlaceholder: 'np. ICMarketsSC-MT5',
      brokerCompanySearchPlaceholder: 'Szukaj po firmie brokera lub nazwie serwera',
      brokerCompanySearchServersHeading: 'Serwery',
      brokerCompanySearchCompaniesHeading: 'Brokerzy',
      brokerCompanySearchEmpty: 'Wyszukaj firmę brokera lub nazwę serwera',
      brokerCompanySearchMinChars: 'Wpisz co najmniej 4 znaki, aby wyszukać',
      brokerCompanySearchNoResults: 'Brak dopasowań w naszym katalogu brokerów.',
      brokerCompanySearchUseQuery: 'Użyj „{query}” jako nazwy serwera',
      brokerCompanySearchLoading: 'Wyszukiwanie brokerów…',
      brokerCompanySearchError: 'Wyszukiwanie brokerów nie powiodło się. Spróbuj ponownie lub wpisz serwer ręcznie.',
      brokerServerPickerTitle: 'Serwer',
      brokerServerSelectPrompt: 'Wyszukaj firmę swojego brokera',
      brokerServerManualToggle: 'Nie możesz znaleźć brokera? Wpisz serwer ręcznie',
      brokerServerManualLabel: 'Nazwa serwera',
      brokerServerManualHint: 'Użyj dokładnej nazwy serwera z terminala MT.',
      mtLoginLabel: 'Login MT',
      mtLoginPlaceholder: 'Numer konta tradingowego',
      passwordLabel: 'Hasło',
      passwordPlaceholder: 'Hasło do konta tradingowego',
      passwordHint: '',
      rememberPasswordLabel: 'Zapamiętaj hasło do automatycznego ponownego połączenia',
      rememberPasswordHint:
        'Szyfruje Twoje hasło MT na naszych serwerach, aby TScopier mógł przywrócić sesję bez ponownego pytania. Możesz je usunąć w dowolnym momencie.',
      connectButton: 'Połącz konto',
      connectingTitle: 'Łączenie brokera',
      connectingStepLinking: 'Łączenie Twojego konta {platform}…',
      connectingStepTerminal: 'Uruchamianie terminala {platform} — zwykle trwa to 10–30 sekund.',
      connectingStepSlow: 'Nadal trwa… pierwsza konfiguracja może potrwać kilka minut.',
      validationRequired: 'Numer konta, hasło i serwer są wymagane',
      connectFailed: 'Nie udało się połączyć konta',
      addMoreButton: 'Dodaj więcej',
      removeRowAria: 'Usuń wiersz konta',
      connectMultipleButton: 'Połącz {count} kont',
      uploadAccountsButton: 'Prześlij konta',
      accountRowTitle: 'Konto {index}',
    },
    bulkConnect: {
      title: 'Prześlij konta MT4/MT5',
      securityNote:
        'Twój plik CSV zawiera hasła tradingowe. Jest przetwarzany wyłącznie w Twojej przeglądarce i nigdy nie jest wysyłany jako plik.',
      downloadTemplate: 'Pobierz szablon CSV',
      uploadCsv: 'Prześlij CSV',
      uploadHint: 'Upuść plik CSV tutaj lub kliknij, aby przeglądać. Kolumna platform (MT4 lub MT5) w każdym wierszu — domyślnie MT5, jeśli brak.',
      previewTitle: 'Podgląd',
      colLabel: 'Etykieta',
      colPlatform: 'Platforma',
      colServer: 'Serwer',
      colLogin: 'Login',
      colPassword: 'Hasło',
      colStatus: 'Status',
      parseErrorLine: 'Wiersz {line}: {message}',
      noValidRows: 'W pliku CSV nie znaleziono prawidłowych kont.',
      connectCount: 'Połącz {count} kont',
      connectingTitle: 'Łączenie kont…',
      statusQueued: 'W kolejce',
      statusLinking: 'Łączenie…',
      statusLinked: 'Połączono',
      statusFailed: 'Błąd',
      statusSkippedDuplicate: 'Duplikat',
      statusSkippedLimit: 'Osiągnięto limit',
      statusSkippedInvalid: 'Nieprawidłowe',
      summaryTitle: 'Połączone konta',
      summaryBody: '{linked} połączono, {failed} zakończyło się błędem, {skipped} pominięto.',
      summaryFailedTitle: 'Konta z błędem',
      dismiss: 'Zamknij',
      viewBrokers: 'Zobacz brokerów',
    },
    brokerList: {
      statusPaused: 'Wstrzymane',
      statusConnected: 'Połączone',
      statusConnecting: 'Łączenie',
      statusRecovering: 'Ponowne łączenie',
      statusError: 'Błąd',
      statusDisconnected: 'Rozłączone',
      copyTrades: 'Kopiuj transakcje',
      reconnect: 'Połącz ponownie',
      reconnectAll: 'Połącz wszystkie ponownie',
      configure: 'Konfiguruj',
      removeAria: 'Usuń {label}',
      detailLogin: 'Login',
      detailAccountType: 'Typ konta',
      accountTypeDemo: 'Demo',
      accountTypeLive: 'Rzeczywiste',
      accountTypePropFirm: 'Firma prop',
      detailServer: 'Serwer',
      detailSignalChannels: 'Kanały sygnałów',
      detailBalance: 'Saldo',
      detailEquity: 'Kapitał',
      channelsNoneSelected: 'Nic nie wybrano',
      channelsEmptySaveWarning:
        'Nie wybrano żadnych kanałów sygnałowych — to konto brokera nie będzie kopiować żadnych sygnałów z Telegrama. Zapisać mimo to?',
      channelsSaveChannelListNotReady:
        'Lista kanałów wciąż się ładuje. Poczekaj chwilę i spróbuj ponownie.',
      channelsSaveLinkedChannelsInvalid:
        'Nie udało się zapisać powiązanych kanałów. Odśwież stronę i spróbuj ponownie.',
      channelsSignalChannel: 'Kanał sygnałowy',
      channelsAll: 'Wszystkie kanały sygnałowe',
      relinkOne:
        'To konto używa starszego formatu powiązania. Usuń je i połącz ponownie, używając loginu MT i hasła.',
      relinkMany:
        '{count} kont używa starszego formatu powiązania. Usuń każde z nich i połącz ponownie, używając loginu MT i hasła.',
      reconnectDroppedOne:
        'Sesja tradingowa wygasła na serwerze handlowym. Użyj opcji Połącz ponownie i wpisz aktualne hasło MT.',
      reconnectDroppedMany:
        '{count} kont utraciło połączenie z brokerem i jest oznaczonych jako Rozłączone. Użyj opcji Połącz ponownie dla każdego konta.',
      connectErrorWrongPassword:
        'Hasło do konta MT jest nieprawidłowe. Sprawdź hasło w terminalu MetaTrader, a następnie spróbuj ponownie.',
      connectErrorWrongLogin:
        'Numer loginu MT nie pasuje do tego serwera brokera. Zweryfikuj numer konta w MetaTraderze.',
      connectErrorWrongServer:
        'Nazwa serwera brokera jest nieprawidłowa lub nie pasuje do tego loginu. Sprawdź dokładną nazwę serwera w MetaTraderze.',
      connectErrorInvestorPassword:
        'Użyto hasła inwestora (tylko do odczytu). Połącz, używając głównego hasła tradingowego z MetaTradera.',
      connectErrorAccountDisabled:
        'To konto MT jest wyłączone lub zablokowane u brokera. Skontaktuj się z brokerem lub najpierw zaloguj się przez MetaTradera.',
      connectErrorCredentialsRejected:
        'Nie udało się zalogować przy użyciu tych danych MT. Zweryfikuj numer konta, hasło tradingowe i dokładną nazwę serwera z MetaTradera.',
      connectErrorTerminalNotReady:
        'Nie udało się jeszcze wczytać konta od brokera. Jeśli właśnie się połączyłeś, odczekaj minutę i spróbuj ponownie. W przeciwnym razie sprawdź, czy login MT, hasło i serwer dokładnie odpowiadają MetaTraderowi.',
      connectErrorSessionExpired:
        'Sesja tradingowa wygasła na serwerze handlowym. Użyj opcji Połącz ponownie i wpisz aktualne hasło MT.',
      connectErrorUnknown:
        'Połączenie z brokerem nie powiodło się. Sprawdź dane logowania MT lub użyj opcji Połącz ponownie, jeśli konto było już wcześniej podłączone.',
      reconnectFailed: 'Nie udało się ponownie połączyć brokera',
      reconnectPasswordTitle: 'Sesja brokera wygasła',
      reconnectPasswordBody:
        'Twoja sesja brokera wygasła na serwerze handlowym. Wpisz hasło do konta MT, aby połączyć ponownie.',
      reconnectPasswordLabel: 'Hasło konta MT',
      reconnectPasswordHint:
        'Wysyłane tylko do serwerów MT. Włącz opcję zapamiętywania poniżej, aby zapisać je szyfrowane do automatycznego ponownego połączenia.',
      reconnectPasswordPlaceholder: 'Hasło do konta tradingowego',
      rememberPasswordLabel: 'Zapamiętaj hasło do automatycznego ponownego połączenia',
      rememberPasswordHint:
        'Przechowuje zaszyfrowaną kopię, aby TScopier mógł łączyć ponownie bez ponownego pytania. Możesz ją usunąć w Konfiguracji konta.',
      clearStoredCredentials: 'Usuń zapisane hasło',
      storedCredentialsActive: 'Automatyczne ponowne łączenie włączone',
      deleteFailed: 'Nie udało się usunąć brokera',
      deleteSessionExpired:
        'Twoja sesja logowania wygasła. Odśwież stronę i spróbuj ponownie albo wyloguj się i zaloguj ponownie.',
      duplicateMtLogin:
        'Ten login MT jest już powiązany z innym kontem tutaj. Najpierw je usuń lub użyj opcji Połącz ponownie — tego samego loginu nie można połączyć dwa razy.',
      platformServerMismatchMt4:
        'Ta nazwa serwera wygląda na MT4, ale wybrano MT5. Kopiowanie i zarządzanie transakcjami może nie działać poprawnie. Połączyć jako MT4?',
      platformServerMismatchMt5:
        'Ta nazwa serwera wygląda na MT5, ale wybrano MT4. Kopiowanie i zarządzanie transakcjami może nie działać poprawnie. Połączyć jako MT5?',
      deleteTitle: 'Usunąć konto tradingowe?',
      deleteBody: 'To odłączy {label} od brokera i kopiarki. Tej operacji nie można cofnąć.',
      deleteConfirm: 'Odłącz',
      connectedAccountsHeading: 'Połączone konta',
      connectedAccountsUnlimited: 'Bez limitu',
      brokerFilterLabel: 'Broker',
      brokerFilterAll: 'Wszyscy brokerzy',
      brokerFilterNoMatch: 'Żadne konto nie pasuje do tego brokera.',
      accountSearchLabel: 'Szukaj kont',
      accountSearchPlaceholder: 'Etykieta, login, serwer, broker…',
      accountSearchNoMatch: 'Żadne konto nie pasuje do wyszukiwania.',
    },
    brokerConnectedSuccess: {
      title: 'Broker połączony',
      titlePending: 'Broker powiązany',
      body: '{account} jest połączone i gotowe do kopiowania sygnałów.',
      bodyPending:
        '{account} jest powiązane. Twój terminal MT5 uruchamia się — możesz konfigurować kanały podczas łączenia.',
      addChannel: 'Dodaj kanał',
      configure: 'Konfiguruj',
    },
    configureModal: configureModalPl,
  },
}
