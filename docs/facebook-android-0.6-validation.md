# Facebook Watcher 0.6 — raport końcowy offline

Stan: 2026-10-15. Draft PR #23 pozostaje bez merge.

Kod zweryfikowany w CI: `34c45a86339fab4bb721abd9c68a97e47bb673cc`.
Lokalny odpowiednik: `9c34516319c1abf153a51b6ccefed2f9feef3ad6`.
Identyczne SHA drzewa: `82bc92b2968710e600d6d477241542515573f380`.
Końcowy commit dokumentacji zmienia tylko raporty; nie wymaga ponownego builda.

## Wykonane sprawdzenia

| Zakres | Wynik | Dowód |
|---|---|---|
| TypeScript, ESLint, pełny Next.js build | PASS | [backend CI](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38737248165) |
| Backend, regresje, offline/core | 389 PASS: 88 +243 +58 | ten sam workflow oraz lokalne wykonanie testów |
| PostgreSQL 16 | 16/16 PASS | ten sam workflow, job postgres |
| Kotlin compile, JVM, APK | PASS | [APK CI](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38737245746) |
| Android 16 samodzielny emulator | PASS; test API pominięty, bo bez fixture | [emulator CI](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38737245847) |
| Android 16 + WebView + HMAC API + PostgreSQL | 9/9 PASS, 0 pominiętych | [pełne E2E](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38737248216) |

Dodano 9 testów JVM silnika: 13 źródeł i kontynuacja, utrata odpowiedzi, awaria
między checkpointem i wyczyszczeniem outboxa, wygasły lease, heartbeat/anulowanie,
warunki urządzenia, fencing po utracie heartbeat, uszkodzony stan/domena danych,
Wi-Fi/API reconnect oraz uwzględnienie czasu synchronizacji w limicie cyklu
(część scenariuszy obejmuje kilka warunków w jednym teście). Zachowano dotychczasowe
testy JVM i testy WorkManagera.

Wszystkie cztery workflow są completed/success dla wskazanego head_sha. Nazwy
artefaktów zawierają techniczny SHA refs/pull/23/merge generowany przez GitHub do
CI; nie wykonano merge PR do main.

## Dowody przepływu i bezpieczeństwa

- 13 syntetycznych źródeł: 11 grup i 2 profile, w tym niedostępny profil.
- Lokalnie wyłączona jedna grupa pozostaje wyłączona po kolejnych synchronizacjach.
- 11 dozwolonych źródeł otrzymuje terminalny wynik: jedna awaria, jedno puste źródło,
  pozostałe przetwarzane dalej. Profile i grupy mają oddzielne tożsamości źródeł.
- Awaria API po rezerwacji/przed transakcją: ponowienie tylko idempotentnego,
  atomowego adaptera OFFLINE_TEST; produkcyjny LIVE pozostaje fenced.
- Utrata odpowiedzi po commit oraz odtworzenie Androida: identyczny rawBody i
  completionId, receipt zapisany razem z kursorem przed usunięciem outboxa.
- Drugi cykl wykonuje rzeczywisty AutoScanWorker w dozwolonym oknie.
- Pierwszy cykl: 9 fizycznych ofert. Drugi: 0 nowych, 0 aktualizacji, 9 duplikatów.
  Baza nadal ma 9 ofert i 20 ukończonych checkpointów batch (puste batch też są
  potwierdzane; błędy źródła nie tworzą batch importu).
- PostgreSQL sprawdza równoległy claim, konflikt urządzeń, scope/RLS/uprawnienia,
  wygasanie i fencing, rollback konfliktu źródła, same-batch replay oraz wyścig
  różnych batch: jeden insert, jeden duplikat, zero pozornych aktualizacji.
- Czas synchronizacji i odzyskiwania wlicza się w 8 minut, z 35 sekundami rezerwy.
  Następny cykl bierze wyłącznie pozostałe źródła w tym samym oknie.
- UI ma ostatni sync, status fixture urządzenia/kolejki/outboxa, bezpieczne kody
  błędów, lokalne przełączniki, wyniki grup i dokładne potwierdzone liczniki.
- Dane OFFLINE_TEST są w osobnym zaszyfrowanym dzienniku, bez DEMO/LIVE, cookies,
  sesji Facebooka lub produkcyjnych poświadczeń. Lokalny HTTPS wymaga publicznego
  certyfikatu fixture, normalnej walidacji hosta i loopback origin.

## APK i instalacja

[Pobierz APK 0.6 — artefakt build 27](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38737245746/artifacts/11974058338).
Archiwum artefaktu zawiera app-debug.apk. Pobranie może wymagać logowania do GitHuba.
Retencja tego artefaktu: do 2026-11-14; nie jest to stały release.

- versionName: `0.6.0-offline-debug`, versionCode: `27`.
- applicationId: `pl.jakubokruszek.flipcollector.integration` (obok produkcyjnej).
- APK SHA-256: `ce08587ed5b5f5e5fa5cd588431622b45da39ec695152d8aff670f53e5dba432`.
- SHA-256 ZIP artefaktu: `d466148b8194b93a827eed42196e2211fc36d45997bbd6d511c011200b0dcdfe`.
- `LIVE_COLLECTION_ENABLED=false`, `ANDROID_BACKEND_INTEGRATION_ENABLED=false`.

[Artefakt osobnego builda E2E](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38737248216/artifacts/11973734080)
pochodzi z tych samych źródeł, z domyślnym versionCode testów; podstawowy pakiet do
instalacji powyżej ma versionCode=27. Nie usuwano danych telefonu. Instalacja lub
aktualizacja na fizycznym Samsungu nie była wykonywana; w razie konfliktu podpisu
istniejącej testowej instalacji nie odinstalowywać jej ani nie czyścić danych.

Instrukcja lokalnej bazy/HTTPS/adb i panelu:
[facebook-android-0.6-offline.md](facebook-android-0.6-offline.md).
Kontrakt: [facebook-android-backend-contract.md](facebook-android-backend-contract.md).
[Raporty E2E/JVM](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38737248216/artifacts/11973704398).

## Granice i konkretne kroki do pierwszego LIVE

Nie wykonano fizycznych testów Samsunga 0.6, prawdziwego Facebooka, sesji/loginu,
pełnej produkcyjnej ścieżki persistence Findera, wdrożenia backendu ani migracji
Supabase. Dokładne liczniki są dowiedzione dla izolowanego adaptera; historyczne
niezweryfikowane liczniki produkcyjne pozostają nieznane, a nie wymyślone.

1. Zainstalować 0.6 obok produkcyjnej aplikacji i wykonać fixture offline na Samsungu
   według instrukcji, z Wi-Fi/ładowaniem, restartem, przerwaniem API, oknem i temperaturą.
2. Zweryfikować pełną produkcyjną ścieżkę Findera i jej transakcyjne liczniki/checkpointy
   na izolowanej kopii schematu. Nie włączać fixture-only atomic replay dla nieatomowego
   importera. Uzgodnić bezpieczne odzyskiwanie częściowych importów.
3. Przejrzeć draft SQL pod pełny aktualny schemat, RLS i granty oraz retencję dziennika
   (teraz limit 500 potwierdzeń zatrzymuje zapis zamiast usuwać je po cichu).
4. Uzyskać osobne zatwierdzenie staging/deploymentu/migracji i konfiguracji canary;
   sparować prawdziwe urządzenie ANDROID_WEBVIEW z minimalnym zakresem jednej grupy.
   Nie zmieniać aktywnego filtra Flip ani OLX w ramach tego zadania.
5. Uzyskać osobną zgodę na sesję Facebooka i przyszły build z jawnie dopuszczonym LIVE.
   Obecny APK nie otwiera tych bramek przełącznikiem UI. Nie obchodzić challenge/CAPTCHA.
6. Wykonać jeden kontrolowany skan prawdziwej grupy przy włączonym ekranie i bez
   Vision; porównać identyfikację postów, zdjęcia, deduplikację, liczniki i receipt.
   Dopiero później kwalifikować pracę nocną na Samsungu: wygaszony ekran, Doze,
   kwoty WorkManagera, temperatura i utrata internetu. Emulator nie zastępuje tego testu.

Nie uruchomiono nowych płatnych usług ani Vision. Wykorzystano istniejące standardowe
GitHub Actions dla publicznego repo; nie wykonywano pomiaru rozliczenia konta.
Rollback offline: odłączyć fixture, wyłączyć harmonogram, zatrzymać lokalne procesy
oraz kontener. Nie ma zmian produkcyjnych do cofnięcia.

## Zapisane commity 0.6

| Lokalny commit | Opublikowany odpowiednik |
|---|---|
| 656abf0e5f6cd0019399a7a549caa380c4b395eb | b4e42f2b616487b83a74fe5131d6f45b2f265591 |
| 323470ee2cd3cef7a1e35d4bb519f8c1a72b3d9f | c5258fd4966da5f048d35a8125d5c2c9145b59e1 |
| d0c4d5708da9e7ab7af882be258dc066881faf54 | e3b4220542911ced4d609513b9b0d54880ffadcd |
| 445120983f9f0d9a6748eaaceddcaf0b02b92481 | 3213a32a0ff99b0a1960c3f0d54b514640f1914c |
| dd8da84b8deecc1a18117b0cf6f93e7ebc2882e1 | 4466367e6d1d5f11fccbd0b58171ea1543302518 |
| 9c34516319c1abf153a51b6ccefed2f9feef3ad6 | 34c45a86339fab4bb721abd9c68a97e47bb673cc |

Oryginalne 12 commitów i ZIP zachowano lokalnie. ZIP SHA-256 nadal:
`1769bcec98466da2b7146ec7fc09c449539da29225a36dbe72e74aff6165c837`.
Main nadal `642fdf3301d08cd0151526625bd05ced3bc2fd43`. PR #22 bez zmian.
