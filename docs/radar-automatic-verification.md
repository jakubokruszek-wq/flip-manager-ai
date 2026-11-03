# Automatyczna weryfikacja Radaru

Radar przed świeżym wyszukiwaniem ponownie czyta pełne strony ofert ze swojej
kolejki weryfikacji. Obsługiwane źródła: Gratka, Morizon, Otodom, Oferty.net,
Domiporta, Adresowo i Allegro Lokalnie. Nie wymaga otwartej aplikacji ani
nowego harmonogramu: działa w dotychczasowym skanie i jego kontynuacjach.

## Zasady

- Automatyczna kwalifikacja korzysta z dotychczasowych filtrów cen, metrażu,
  dzielnic, rodzaju budynku, rynku i standardu A/B. Brak danych pozostaje
  brakiem; automat nie zatwierdza oferty w imieniu operatora.
- Gratka i Morizon dostarczają teraz pełne dane konkretnego ogłoszenia z
  publicznego `__NUXT_DATA__`, zamiast samego 300-znakowego skrótu listy.
  Parser sprawdza ID, sprzedaż mieszkania, PLN i aktywność. Oznaczenie
  archiwum w danych strony wyklucza ofertę mimo odpowiedzi HTTP 200.
- Remont klatki, elewacji, innego lokalu lub planowane prace nie stanowią
  dowodu wykonanego remontu mieszkania. Niejednoznaczne opisy nie trafiają
  automatycznie do próby statystycznej.
- Ponowny odczyt używa aktualnego tytułu, opisu i lokalizacji pełnego
  ogłoszenia. Historyczny skrót służy do identyfikacji żądania; nie uzupełnia
  braków i nie przenosi dawnej deklaracji „świeżo po remoncie” do nowego opisu.
- Odrzucenia i zatwierdzenia operatora zachowują pierwszeństwo. Zmiana decyzji
  pomiędzy porcjami nie przesuwa kursora. Przed zapisem nadal obowiązują
  kontrola właściciela, dzierżawa skanu, STOP i blokada zmienionej tożsamości.
- HTTP 429/Retry-After i CAPTCHA podlegają dotychczasowym ograniczeniom;
  nie są obchodzone. Blokada portalu nie oznacza braku ofert.

## Wznowienia i przechowywanie

Każdy obsługiwany portal otrzymuje stałą listę maksymalnie 300 zapisanych
identyfikatorów na przebieg, z osobnym kursorem w istniejącym checkpoint JSONB.
Wybierane są najdawniej odczytane pozycje, z pominięciem ofert już aktywnych
w analizie. Nowe wyszukiwanie ma nadal własny kursor. Nie ma migracji bazy.

Po automatycznym dodaniu do porównań zapis kolejki pozostaje jako historia,
bez fałszywej decyzji człowieka. Widok pomija tę pozycję w formularzach ręcznej
weryfikacji, o ile oferta jest już prawidłowo reprezentowana w próbie.
Opis kolejki zachowuje do 60 000 znaków i nadal usuwa dane kontaktowe.

## Sprawdzenie

Testy obejmują rzeczywistą ścieżkę: zapisany kandydat → HTTP szczegółów →
parser → kwalifikacja → zapis z dzierżawą → checkpoint → wznowienie → nowe
wyniki. Osobne testy sprawdzają izolację właścicieli, zmienione decyzje,
usunięte pozycje, złośliwą/cykliczną strukturę danych, brakujące fakty,
archiwum i brak zapożyczania informacji z rekomendacji.
