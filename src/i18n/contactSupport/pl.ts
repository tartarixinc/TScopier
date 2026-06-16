import type { ContactSupportPageTranslations } from './types'

export const contactSupportPl: ContactSupportPageTranslations = {
  channelsTitle: 'Jak możemy pomóc?',
  channelsSubtitle: 'Skontaktuj się z zespołem TSCopier przez e-mail, przejrzyj dokumentację lub rozpocznij czat na żywo.',
  email: {
    title: 'Wsparcie e-mail',
    description: 'Wyślij pytania dotyczące konta, rozliczeń lub kopiowania - zazwyczaj odpowiadamy w ciągu jednego dnia roboczego.',
    cta: 'Napisz do wsparcia',
  },
  docs: {
    title: 'Dokumentacja',
    description: 'Instrukcje krok po kroku dotyczące podłączania brokerów, kanałów Telegram, stylów transakcji i rozwiązywania problemów.',
    cta: 'Otwórz dokumentację',
  },
  liveChat: {
    title: 'Czat na żywo',
    description: 'Porozmawiaj z nami w czasie rzeczywistym, aby szybko uzyskać pomoc podczas konfiguracji w panelu.',
    cta: 'Rozpocznij czat',
  },
  faq: {
    title: 'Najczęściej zadawane pytania',
    subtitle: 'Szybkie odpowiedzi, zanim się z nami skontaktujesz.',
    items: [
      {
        question: 'Jak podłączyć moje konto MetaTrader?',
        answer:
          'Otwórz Konfigurację, dodaj konto brokera, wpisz dane logowania MetaTrader i poczekaj, aż status połączenia pokaże połączono. Dla każdego podłączonego konta trzeba zapisać styl transakcji, wielkość lota i wybór kanału, zanim rozpocznie się kopiowanie.',
      },
      {
        question: 'Dlaczego moje sygnały z Telegrama nie są kopiowane?',
        answer:
          'Sprawdź, czy broker jest połączony, kanał Telegram jest podłączony i aktywny, kanał jest wybrany przy brokerze w Konfiguracji, subskrypcja jest aktywna, a e-mail zweryfikowany. Przejrzyj Copier Logs pod kątem powodów pomijania, takich jak filtry kanału, blokada wydarzeń makro lub brak SL/TP w sygnale.',
      },
      {
        question: 'Jak dodać kanał sygnałowy Telegram?',
        answer:
          'Przejdź do Kanałów, podłącz Telegram, jeśli to konieczne, a następnie dodaj nazwę użytkownika kanału lub link zaproszeniowy. Włącz kanał i przypisz go do kont brokerów, które mają kopiować jego sygnały, w Konfiguracji.',
      },
      {
        question: 'Co robi blokada handlu podczas newsów / kalendarza ekonomicznego?',
        answer:
          'Gdy handel podczas newsów jest wyłączony na koncie, TSCopier może wstrzymać nowe wejścia i opcjonalnie zamknąć otwarte transakcje wokół wydarzeń o wysokim znaczeniu. Użyj strony Kalendarz ekonomiczny, aby sprawdzić nadchodzące publikacje i skonfigurować zasady w Konfiguracji konta.',
      },
      {
        question: 'Czy do kopiowania transakcji potrzebna jest płatna subskrypcja?',
        answer:
          'Do wykonywania kopiowania sygnałów Telegram na żywo wymagany jest aktywny plan płatny. Nadal możesz przeglądać panel i konfigurację w dostępnym okresie próbnym; sprawdź Rozliczenia, aby zobaczyć bieżący plan i status odnowienia.',
      },
      {
        question: 'Dlaczego muszę zweryfikować e-mail przed korzystaniem z platformy?',
        answer:
          'Weryfikacja e-mail potwierdza Twoje logowanie i pozwala nam wysyłać potwierdzenia płatności oraz ważne alerty dotyczące konta. Jeśli utkniesz na ekranie weryfikacji, użyj linku ponownej wysyłki lub skontaktuj się ze wsparciem, podając adres użyty przy rejestracji.',
      },
      {
        question: 'Mój broker pokazuje rozłączenie - co mogę zrobić?',
        answer:
          'Potwierdź, że MetaTrader działa po stronie brokera, dane logowania są nadal poprawne i konto nie jest zablokowane. Odśwież połączenie w Konfiguracji, a następnie sprawdź Copier Logs pod kątem błędów sesji. Jeśli problem nadal występuje, napisz do wsparcia, podając nazwę brokera i login konta (nigdy hasło).',
      },
      {
        question: 'Czy mogę kopiować ten sam kanał na wiele kont brokerskich?',
        answer:
          'Tak. Podłącz każde konto MetaTrader osobno w Konfiguracji i wybierz ten sam kanał Telegram dla każdego brokera. Wielkość lota, styl transakcji i ustawienia ryzyka są konfigurowane per konto.',
      },
    ],
  },
}
