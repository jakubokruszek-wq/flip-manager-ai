# Aktywne grupy — analiza i kolejność skanowania

## Stan danych rzeczywistych

Użytkownik potwierdził odczyt Supabase: 15 zapisanych źródeł, 13 aktywnych dla
Łodzi, w tym 11 grup i 2 profile. Jeden aktywny profil ma status UNAVAILABLE
z historycznym błędem COLLECTOR_PROFILE_URL_INVALID. Są to metadane przekazane
przez użytkownika; nie wykonano ponownego odczytu produkcji. Bez nazw, URL-i i
historii nie ma podstaw do imiennego rankingu ani przypisywania skuteczności.
Planer odkłada niedostępny profil: przy tej strukturze danych pozostaje 12
kandydatów (11 grup + 1 profil), o ile ich URL-e i pozostałe statusy są poprawne.
Test syntetyczny sprawdza dokładnie taką strukturę 15/13/11/2.
Nie wykonano skanu Facebooka ani zmian danych źródeł.

Gotowe zapytania zawiera `facebook-android-active-groups-readonly.sql`. Obejmują
aktywny rejestr grup i metadane zakończonych zadań z 14 dni. Są opakowane w
transakcję READ ONLY z limitem czasu; nie czytają tokenów, treści postów, filtrów
ani konfiguracji płatności. W tej sesji nie zostały pomyślnie wykonane.

## Proponowana polityka

Funkcja `planAndroidFacebookScans` jest odrębnym, czysto obliczeniowym podglądem.
Nie modyfikuje istniejących harmonogramów, nie zapisuje kolejki i nie ma połączenia
z OLX. Bez jawnego `preview:true` lub `enabled:true` zwraca `DISABLED` i pusty plan.
`enabled:true` również tylko oblicza plan; nie uruchamia skanów.

1. Tylko `enabled=true`, poprawny kanoniczny URL Facebooka i status `CONNECTED`
   lub `MANUAL_IMPORT`. Wymagające logowania/niedostępne/nieznane źródła odkładamy
   do ręcznego sprawdzenia; nie obchodzimy checkpointów.
2. Priorytet operatora: `high`, następnie `normal`, potem `low`.
3. W ramach priorytetu źródła bez obserwacji lub niesprawdzane przez 24h dostają
   kolej eksploracyjną, najstarsze najpierw, aby nie głodować mniej aktywnych grup.
4. Pozostałe źródła: skuteczność na minutę, z maksymalnie 20 ostatnich obserwacji.
   Nowy wpis ma słaby prior zamiast wymyślonych statystyk. Ostatnie niepowodzenia
   obniżają ocenę. Koszt to mediana czasu, a brak czasu pozostaje jawnie null.
5. Remisy rozstrzyga ostatni czas sprawdzenia i identyfikator źródła. Identyczne
   źródła tego samego typu nie pojawiają się dwukrotnie w planie.

Ocena w obrębie priorytetu/klasy zaległości:

```text
expectedUseful = (1 + sum(created) + 0.25 * sum(updated)) / (2 + knownYieldScans)
reliability    = (1 + nonFailedScans) / (2 + observedScans)
score          = expectedUseful * reliability * 60000 / max(15000, medianDurationMs ?? 90000)
```

Parametry są lokalną propozycją, nie zmianą aktywnego filtra ani ustawień grup.
Testy na 13 syntetycznych grupach sprawdzają stabilność, eksplorację, priorytet,
czas i odrzucanie niewłaściwych źródeł. Wyniki testów nie są statystykami produkcji.

## Odtworzenie podglądu po uzyskaniu odczytu

Złóż lokalny plik JSON z obu wyników zapytań:

```json
{"snapshotAt":"2026-10-15T06:00:00Z", "groups":[], "history":[]}
```

`groups` to wiersze pierwszego SELECT; `history` to wiersze drugiego.
`activeGroupCount` i `scopeTotal` pozwalają wykryć obcięty eksport — skrypt odmawia
rankingu, jeśli nie pobrano wszystkich stron. Daty i czasy dotyczą tego samego
snapshotu. Pola NULL pozostają NULL. Rzeczywiste dane nie są commitowane do repo.

```sh
node scripts/facebook-android-plan-preview.mjs /ścieżka/read-only-export.json
```

Wynik zawiera `mode=PREVIEW`, uzasadnienia, mediany czasów, liczby obserwacji,
źródła odłożone oraz `executedScans=0`. Nie ma efektów w bazie ani na Facebooku.
