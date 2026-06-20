import type { LegalDocumentPageTranslations } from './types'
import { legalContactPl } from './contactPl'

export const cookiePolicyPl: LegalDocumentPageTranslations = {
  title: 'Polityka plików cookie',
  lastUpdated: 'Ostatnia aktualizacja: 8 czerwca 2026 r.',
  intro:
    'Niniejsza Polityka plików cookie wyjaśnia, w jaki sposób Tartarix, Inc. („my”, „nas” lub „nasze”) używa plików cookie i podobnych technologii na stronach internetowych i w aplikacjach TScopier. Należy ją czytać łącznie z naszą Polityką prywatności.',
  sections: [
    {
      title: '1. Czym są pliki cookie?',
      paragraphs: [
        'Pliki cookie to małe pliki tekstowe zapisywane na urządzeniu podczas odwiedzania strony internetowej. Podobne technologie obejmują local storage, session storage i piksele. Pomagają one zapamiętywać preferencje, utrzymywać zalogowanie i rozumieć sposób korzystania z Usługi.',
      ],
    },
    {
      title: '2. Jak używamy plików cookie',
      paragraphs: [
        'Niezbędne pliki cookie: wymagane do uwierzytelniania, bezpieczeństwa, atrybucji poleceń i działania kluczowych funkcji (np. stan sesji, obecność uwierzytelnienia między subdomenami, jeśli skonfigurowano). Nie można ich wyłączyć podczas korzystania z Usługi.',
        'Pliki cookie preferencji: zapamiętują wybory, takie jak język, status zgody na cookie i zamknięte banery.',
        'Analityczne pliki cookie: gdy zaakceptujesz cookie w naszym banerze, możemy używać Google Analytics oraz powiązanych identyfikatorów do analizy ruchu i użycia funkcji. Zdarzenia analityczne mogą obejmować ścieżki stron, kody poleceń i pseudonimowe identyfikatory — nie obejmują haseł brokerskich ani instrukcji transakcyjnych.',
      ],
    },
    {
      title: '3. Pliki cookie, które ustawiamy',
      paragraphs: [
        'Przykłady: uwierzytelniające/sesyjne pliki cookie naszego dostawcy auth; tsc_tracking_consent i tsc_tracking_seen_ts (wybór z banera cookie); tsc_analytics_id (pseudonimowy identyfikator analityczny, gdy analityka działa); tsc_ref i tsc_ref_ts (atrybucja poleceń); tsc_auth (krótkotrwała wskazówka logowania między subdomenami, jeśli włączona).',
        'Nazwy i okresy życia mogą się zmieniać wraz z rozwojem Usługi. Niezbędne pliki cookie zwykle wygasają po wylogowaniu lub po określonym okresie bezpieczeństwa.',
      ],
    },
    {
      title: '4. Pliki cookie stron trzecich',
      paragraphs: [
        'Podmioty trzecie, takie jak Google (Analytics), Stripe (checkout) i nasi dostawcy hostingu, mogą ustawiać własne pliki cookie, gdy korzystasz z ich funkcji. Ich użycie regulują ich własne polityki.',
      ],
    },
    {
      title: '5. Twoje wybory',
      paragraphs: [
        'Przy pierwszej wizycie nasz baner cookie umożliwia akceptację lub odrzucenie nieistotnego śledzenia. Możesz zmienić ustawienia przeglądarki, aby blokować lub usuwać pliki cookie; zablokowanie niezbędnych plików cookie może uniemożliwić logowanie lub działanie kluczowych funkcji.',
        'Aby zrezygnować z Google Analytics w obsługiwanych regionach, możesz też skorzystać z dodatku Google do przeglądarki lub mechanizmów prywatności swojej przeglądarki.',
      ],
    },
    {
      title: '6. Aktualizacje',
      paragraphs: [
        'Możemy okresowo aktualizować niniejszą Politykę plików cookie. Data „Ostatnia aktualizacja” u góry odzwierciedla najnowszą wersję.',
      ],
    },
  ],
  closing:
    'Masz pytania dotyczące plików cookie? Napisz na legal@tscopier.ai lub zapoznaj się z naszą Polityką prywatności.',
  contact: legalContactPl,
}
