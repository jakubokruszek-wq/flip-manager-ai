# Stan weryfikacji 0.5.68 — 2026-10-30 UTC

**Kandydat lokalny, bez wydania APK i bez wdrożenia backendu.**

Punkt wyjścia: `claude/facebook-watcher-mobile-gq36l8`, commit
`6d6f64e9260a8a9d5900c350a6f8d86dc135e174`, wersja 0.5.67.

| Sprawdzenie | Wynik |
| --- | --- |
| Kompilacja bieżącego kodu Androida i instrumentacji, oba APK | PASS |
| Testy JVM | PASS: 310, 0 błędów |
| Parser i adapter JavaScript | PASS: 579, 0 błędów |
| Kontrakt mobilnego HTTP: retry po utracie odpowiedzi, tożsamość, zdjęcia, limity | PASS: 5 testów syntetycznych |
| Istniejący importer i zachowanie bogatszych danych Managera | PASS: 2 testy z atrapą bazy |
| TypeScript `tsc --noEmit` | PASS |
| ESLint dla zmienionego kodu backendu | PASS |
| Guard zakresu i niezmienionego collector-core | PASS |
| Stały certyfikat ARM64 APK | PASS: zgodny z 0.5.67 |
| Nowe testy urządzeniowe kolejki i tła Gecko | NIEURUCHOMIONE: błąd instalacji APK w środowisku emulatora |
| Pełna dotychczasowa regresja Androida | NIEURUCHOMIONA dla tej wersji |
| Telefon z prawdziwą sesją Facebooka, restart, brak sieci, odbiór w Managerze | NIEZWERYFIKOWANE |
| Wdrożenie `/api/collector/facebook/mobile` | NIEWYKONANE |

Końcowy lokalny build: `testDebugUnitTest assembleDebug assembleDebugAndroidTest`,
wynik `BUILD SUCCESSFUL`. APK ma applicationId
`pl.jakubokruszek.flipwatcher.geckopoc`, versionCode 5000,
versionName `0.5.68-gecko-poc` oraz certyfikat SHA-256:
`878b11e677eb4a62883b0b8709fa19c969926708053a01d47f01b0548fb370a2`.

Lokalny emulator API 36 uruchomiono bez KVM, z programowym renderowaniem.
System zakończył boot, lecz UTP zgłosił timeout instalacji `app-x86_64-debug.apk`
po 360000 ms (`AndroidTestApkInstallerPlugin`, kod 2002). Nie wykonano żadnego
z nowych testów urządzeniowych. Ten błąd nie jest wynikiem testu aplikacji.
Nie ma podstaw do uznania ścieżki tła Gecko i zdjęć za działającą na urządzeniu.

Zapis drzewa zmian do GitHuba zwrócił `user cancelled MCP tool call`.
Nie utworzono commita/gałęzi z tymi zmianami w zdalnym repozytorium; nie uruchomiono
zdalnego CI ani publikacji. Istniejąca produkcja Managera pozostaje bez zmian.

## Dalsze kroki przed wydaniem

1. Zapisać przejrzany kandydat na gałęzi opartej o wskazany punkt wyjścia i uruchomić
   przygotowany workflow `.github/workflows/android-gecko-poc.yml`. Nowa instrumentacja
   `WatcherAutomationInstrumentedTest` ma działać na emulatorze z KVM. Końcowy artefakt
   „flip-watcher…” zależy od powodzenia guard, build i pełnej instrumentacji.
2. Naprawić ewentualne rzeczywiste błędy nowych i dotychczasowych testów. Zachować
   konkretny przetestowany APK i nie zastępować go niezweryfikowanym przebudowaniem.
3. Backend wdrażać osobno na bazie aktualnego `main`: produkcyjne zmiany to
   `features/collector/facebook-import.ts`, `features/collector/facebook-mobile.ts`
   i `app/api/collector/facebook/mobile/route.ts`, wraz z dwoma testami importu/kontraktu.
   Nie wdrażać całego historycznego backendu gałęzi Androida w miejsce bieżącego Managera.
4. Sprawdzić uwierzytelnioną wysyłkę, trwałość receipt i zdjęć w istniejącym Managerze.
   Testy z atrapą bazy nie zastępują tej próby. Nie ma nowych migracji ani płatnego hostingu.
5. Na telefonie zainstalować jako aktualizację, zachować sesję/bazę, włączyć automat
   i sprawdzić wygaszony ekran, restart i ponawianie po utracie połączenia.

Instrukcja i szczegółowe ograniczenia: [automation-0568.md](automation-0568.md).
