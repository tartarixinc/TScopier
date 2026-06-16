import type { LegalDocumentPageTranslations } from './types'
import { legalContactPl } from './contactPl'

export const privacyPolicyPl: LegalDocumentPageTranslations = {
  title: 'Polityka prywatności',
  lastUpdated: 'Ostatnia aktualizacja: 8 czerwca 2026 r.',
  intro:
    'Tartarix, Inc. („Tartarix”, „my”, „nas” lub „nasze”) szanuje Twoją prywatność. Niniejsza Polityka prywatności wyjaśnia, w jaki sposób gromadzimy, wykorzystujemy, ujawniamy i chronimy informacje, gdy korzystasz ze stron internetowych i aplikacji TSCopier („Usługa”).',
  sections: [
    {
      title: '1. Informacje, które gromadzimy',
      paragraphs: [
        'Informacje o koncie: imię i nazwisko, adres e-mail, skrót hasła, preferencje językowe i profilowe, status subskrypcji oraz kody poleceń.',
        'Konfiguracja brokera i handlu: etykiety brokerów, loginy kont (hasła nie są przechowywane jawnym tekstem), typ platformy, wybór kanałów, ustawienia kopiowania i logi wykonania niezbędne do działania Usługi.',
        'Dane handlowe i sygnałowe: identyfikatory kanałów Telegram, sparsowana treść sygnałów, rejestry transakcji, powody pominięć oraz metryki wydajności powiązane z Twoim kontem.',
        'Informacje o płatnościach: status rozliczeń i identyfikatory klienta od naszego operatora płatności. Dane kart są obsługiwane przez operatora i nie są przez nas przechowywane.',
        'Dane techniczne: adres IP, typ przeglądarki, informacje o urządzeniu, pliki cookie, identyfikatory analityczne i zdarzenia użycia (zobacz naszą Politykę plików cookie).',
        'Komunikacja: wiadomości wysyłane na adresy e-mail wsparcia, działu prawnego lub sporów.',
      ],
    },
    {
      title: '2. Jak wykorzystujemy informacje',
      paragraphs: [
        'Świadczenie, utrzymanie i ulepszanie Usługi; uwierzytelnianie użytkowników; przetwarzanie subskrypcji; wykonywanie skonfigurowanych procesów copy-tradingu; wyświetlanie paneli i logów.',
        'Wysyłanie wiadomości transakcyjnych (weryfikacja, rozliczenia, powiadomienia bezpieczeństwa) oraz odpowiadanie na zgłoszenia do wsparcia.',
        'Monitorowanie niezawodności, zapobieganie nadużyciom i oszustwom, egzekwowanie naszych Warunków oraz wypełnianie obowiązków prawnych.',
        'Analiza zagregowanego użycia w celu ulepszania funkcji produktu (z uwzględnieniem Twoich wyborów dot. cookie tam, gdzie ma to zastosowanie).',
      ],
    },
    {
      title: '3. Podstawy prawne (użytkownicy EOG/Wielkiej Brytanii)',
      paragraphs: [
        'Jeżeli zastosowanie mają RODO lub podobne przepisy, przetwarzamy dane osobowe na podstawie: wykonania umowy (świadczenie Usługi), prawnie uzasadnionych interesów (bezpieczeństwo, analityka, rozwój produktu), zgody (nieistotne cookie/marketing tam, gdzie wymagane) oraz obowiązku prawnego.',
      ],
    },
    {
      title: '4. Jak udostępniamy informacje',
      paragraphs: [
        'Dostawcy usług: hosting i baza danych (np. Supabase), przetwarzanie płatności (np. Stripe), dostarczanie e-maili, analityka (np. Google Analytics po wyrażeniu zgody), API łączności brokerskiej oraz narzędzia wsparcia klienta — wyłącznie w zakresie niezbędnym do działania Usługi.',
        'Nie sprzedajemy Twoich danych osobowych. Możemy ujawnić informacje, jeśli wymaga tego prawo, aby chronić prawa i bezpieczeństwo, lub w związku z fuzją, przejęciem albo sprzedażą aktywów, przy zastosowaniu odpowiednich zabezpieczeń.',
      ],
    },
    {
      title: '5. Transfery międzynarodowe',
      paragraphs: [
        'Możemy przetwarzać i przechowywać informacje w Stanach Zjednoczonych i innych krajach, w których działamy my lub nasi dostawcy. Tam, gdzie wymagają tego przepisy, stosujemy odpowiednie zabezpieczenia dla transferów transgranicznych.',
      ],
    },
    {
      title: '6. Okres przechowywania',
      paragraphs: [
        'Przechowujemy informacje tak długo, jak Twoje konto jest aktywne, oraz tak długo, jak jest to potrzebne do świadczenia Usługi, rozwiązywania sporów, egzekwowania umów i spełniania wymogów prawnych. Możesz zażądać usunięcia danych z zastrzeżeniem wyjątków (np. dokumentacja rozliczeniowa, którą musimy zachować).',
      ],
    },
    {
      title: '7. Bezpieczeństwo',
      paragraphs: [
        'Stosujemy środki administracyjne, techniczne i organizacyjne zaprojektowane w celu ochrony informacji. Żadna metoda transmisji ani przechowywania nie jest w 100% bezpieczna; nie możemy zagwarantować całkowitego bezpieczeństwa.',
      ],
    },
    {
      title: '8. Twoje prawa i wybory',
      paragraphs: [
        'W zależności od lokalizacji możesz mieć prawo do dostępu, sprostowania, usunięcia, ograniczenia lub przenoszenia danych osobowych oraz do sprzeciwu wobec określonego przetwarzania. Ustawienia profilu możesz aktualizować w aplikacji, a preferencje cookie zarządzać za pomocą naszego banera cookie.',
        'Aby skorzystać z praw dotyczących prywatności, skontaktuj się pod adresem legal@tscopier.ai. Przed odpowiedzią możemy zweryfikować Twoją tożsamość. Możesz też złożyć skargę do lokalnego organu ochrony danych.',
      ],
    },
    {
      title: '9. Dzieci',
      paragraphs: [
        'Usługa nie jest przeznaczona dla dzieci poniżej 18 roku życia. Nie gromadzimy świadomie danych osobowych dzieci. Skontaktuj się z nami, jeśli uważasz, że dziecko przekazało dane, a my je usuniemy.',
      ],
    },
    {
      title: '10. Zmiany',
      paragraphs: [
        'Możemy okresowo aktualizować niniejszą Politykę prywatności. Opublikujemy zaktualizowaną wersję z nową datą „Ostatnia aktualizacja” oraz, tam gdzie jest to wymagane, przekażemy dodatkowe powiadomienie.',
      ],
    },
  ],
  closing:
    'W sprawach dotyczących prywatności lub żądań związanych z danymi skontaktuj się z legal@tscopier.ai.',
  contact: legalContactPl,
}
