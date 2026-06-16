import type { RiskDisclaimerPageTranslations } from './types'

export const riskDisclaimerPl: RiskDisclaimerPageTranslations = {
  title: 'Ostrzeżenie o ryzyku',
  intro:
    'Handel na rynku Forex, CFD i innymi produktami lewarowanymi wiąże się z istotnym ryzykiem straty. TSCopier jest narzędziem do kopiowania transakcji — nie brokerem, doradcą inwestycyjnym ani planistą finansowym. Nic na tej stronie nie stanowi porady finansowej. To Ty ponosisz wyłączną odpowiedzialność za swoje decyzje tradingowe i wszelkie straty.',
  sections: [
    {
      title: 'Ogólne ryzyko tradingu',
      paragraphs: [
        'Możesz stracić część lub całość zdeponowanego kapitału. Dźwignia finansowa zwiększa zarówno zyski, jak i straty. Historyczne wyniki dostawcy sygnałów, backtestu lub Twojej własnej historii nie gwarantują przyszłych rezultatów.',
        'Rynki mogą tworzyć luki cenowe, być zatrzymywane lub poruszać się bardzo gwałtownie podczas publikacji danych. TSCopier nie gwarantuje, że sygnały zostaną odebrane, zinterpretowane lub wykonane po konkretnej cenie albo w konkretnym czasie.',
      ],
    },
    {
      title: 'Ryzyko dostawcy sygnałów',
      paragraphs: [
        'Kopiuj tylko tych dostawców sygnałów, którym ufasz i których rozumiesz. Dostawcy mogą mieć bodźce sprzeczne z Twoim interesem. Zrzuty ekranu marketingowe, deklaracje skuteczności i wyselekcjonowane wyniki mogą nie odzwierciedlać tego, czego doświadczysz na swoim koncie, przy swoim wolumenie, brokerze lub opóźnieniach.',
        'W miarę możliwości weryfikuj wyniki niezależnie. Dostawca, który sprawdza się u innych, nadal może być nieodpowiedni dla Twojej tolerancji ryzyka, wielkości konta albo godzin handlu.',
      ],
    },
    {
      title: 'Repainting i manipulacja kanałem',
      paragraphs: [
        'Niektóre kanały sygnałowe na Telegramie edytują lub usuwają wiadomości po nieudanej transakcji, aby publiczny feed wyglądał bezbłędnie. "Udane" zagranie mogło zostać poprawione; przegrane może zniknąć całkowicie.',
        'Nie polegaj wyłącznie na widocznej historii kanału ani na zrzutach od osób trzecich. Porównuj dane z własnymi Copier Logs, wyciągami brokera i rejestrami z sygnaturą czasu. Repainting ułatwia dostawcom sprawianie wrażenia bardziej skutecznych, niż są w rzeczywistości.',
      ],
    },
    {
      title: 'Ograniczenia parsowania i realizacji',
      paragraphs: [
        'Sygnały są automatycznie interpretowane z tekstu. Literówki w stop loss (SL) lub take profit (TP) — błędne cyfry, brakujące miejsca dziesiętne, niejednoznaczne symbole albo mieszane jednostki — mogą prowadzić do nieprawidłowych cen. TSCopier może pominąć sygnał, ignorować niepoprawne poziomy albo zastosować domyślne ustawienia z Twojej konfiguracji zamiast intencji dostawcy.',
        'Realizacja może różnić się od wejścia dostawcy: poślizg cenowy, requote, częściowe wykonania, zasady minimalnej odległości i rozłączenia sesji brokera wpływają na wynik. Tryby strict entry, range pending i strategie multi-leg dodatkowo zwiększają złożoność. Zawsze weryfikuj otwarte pozycje u swojego brokera.',
      ],
    },
    {
      title: 'Ryzyka operacyjne i konfiguracyjne',
      paragraphs: [
        'Blokady na czas publikacji danych, filtry kanałów, cele zysku, limity maksymalnej straty, status subskrypcji oraz ustawienia per kanał mogą blokować lub modyfikować kopiowanie. Niepoprawna konfiguracja wolumenu, mapowania symboli lub niepodłączone kanały to częste powody, dla których transakcje nie kopiują się zgodnie z oczekiwaniami.',
        'Automatyczne zamknięcie po osiągnięciu limitów zamyka pozycje przypisane do kanału po stronie TSCopier, ale nie cofa już poniesionej straty rynkowej. Zmiany konfiguracji działają dopiero po zapisaniu — niezapisane wersje robocze nie chronią Twojego konta.',
      ],
    },
    {
      title: 'Pozostań zaangażowany podczas kopiowania',
      paragraphs: [
        'Automatyczne kopiowanie to nie podejście "ustaw i zapomnij". Regularnie monitoruj otwarte pozycje, equity, margin i Copier Logs. Interweniuj u brokera, gdy warunki rynkowe się zmieniają albo gdy przestajesz akceptować ekspozycję dostawcy.',
        'Jeśli nie możesz aktywnie nadzorować swojego konta, kopiowanie sygnałów na żywo może być dla Ciebie nieodpowiednie.',
      ],
    },
    {
      title: 'Jak zwiększyć swoje szanse (to nie porada)',
      paragraphs: [
        'Zacznij od konta demo albo od najmniejszego wolumenu realnego, na który stratę możesz sobie pozwolić. Weryfikuj kanały w czasie; korzystaj z backtestów tam, gdzie są dostępne; włącz limity maksymalnej straty i cele zysku; dostrajaj filtry kanałów; dywersyfikuj między dostawcami zamiast koncentrować ryzyko.',
        'Czytaj powody pomijania sygnałów w Copier Logs, gdy transakcje nie są otwierane. Zachowuj realistyczne oczekiwania — stabilna, niewielka przewaga przy ścisłej kontroli ryzyka to coś zupełnie innego niż marketing typu "szybkie wzbogacenie się".',
      ],
    },
  ],
  closing:
    'Korzystając z TSCopier, potwierdzasz, że trading jest ryzykowny, dostawcy sygnałów mogą być nierzetelni lub wprowadzać w błąd, a Ty przyjmujesz pełną odpowiedzialność za wszystkie transakcje zawierane na połączonych kontach.',
}
