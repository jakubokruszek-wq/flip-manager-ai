# Facebook Android — checkpointy integracji

## A — zabezpieczenie (2026-10-15)

- Start: backend `88f2225c42a37d84d5dd2e3a5cef392eaeb07868`, main
  `642fdf3301d08cd0151526625bd05ced3bc2fd43`. Jeden worktree, sześć zmian
  śledzonych i nieśledzony runner SQL. Istniejącego pyc nie usunięto.
- Zabezpieczenie: `/workspace/facebook-android-master-A.tar.gz`, dwa patche
  (committed + WIP), kontrakt i instrukcja odtworzenia. Nowy pakiet wyklucza
  pyc, pliki ignorowane, node_modules i dane sesji. Odczyt archiwum oraz reverse
  apply --check patcha WIP zakończone powodzeniem.
- SHA256 archiwum: `16417584d5d3790e4a51eddf952b7c25992a9ba99991a626ea9b925cb1e6aa58`.
- Zachowane testy audytu: 78 backendowych i 242 regresyjne PASS z mockami.
  Nie są dowodem wykonania SQL, pełnej kompilacji ani Android E2E.
- Środowisko nadal nie łączy się z proxy npm; brak lokalnego PostgreSQL,
  Gradle/Kotlin. Java jest dostępna. Odczyt GitHub dostępny, ostatni zapis 403.
- Checkout jest częściowy (skip-worktree); pełne sprawdzenia wymagają pełnego
  checkout i instalacji zależności. Nie zastępujemy kompilacji atrapami typów.

## B–I — do wykonania

Stabilizacja backendu, izolowane testy SQL/CI, osobna gałąź integracyjna,
Android API/outbox, adapter offline, symulacja 13 źródeł, E2E i APK oraz
dokumentacja przekazania. LIVE pozostaje wyłączone. Żaden checkpoint nie
stanowi zgody na produkcyjną migrację, deployment lub skan Facebooka.

## B/C — backend i izolowana walidacja

- Checkpoint A/WIP: commit `6217d9b` (pełny SHA dostępny w git log).
- Dodano podpisane źródła/sync, device/status i diagnostics z osobną bramką
  FACEBOOK_ANDROID_INTEGRATION_ENABLED (domyślnie false), bez ujawniania sekretów.
- Draft ma pustą domyślnie tabelę jawnych uprawnień urządzenie/źródło/filtr;
  claim wymaga scope. Nie zmieniono RPC rozszerzenia.
- Dodano idempotentne anulowanie przez istniejącą rezerwację completion.
- Bieżące testy: 84/84 backendowych PASS (61+12+7+4), regresje 242/242 PASS
  przed ostatnim dodatkiem anulowania; wymagany ponowny końcowy przebieg.
- Manual-only workflow `facebook-android-validation.yml`: npm ci, pełny tsc,
  ESLint, Next build, testy oraz osobny PostgreSQL16 z niezależnymi połączeniami,
  wyścigiem urządzeń, blokadą per-device, fencing, receipt, scope, RLS/grantami.
- SQL runner CI przyjmuje wyłącznie stały lokalny serwis CI; nie przyjmuje URL
  produkcji. Testuje draft na minimalnych tabelach. Nie potwierdza pełnej historii
  migracji ani dokładnych atomowych liczników fizycznych zapisów.
- Brak lokalnych zależności, PostgreSQL i dostępu do npm nadal blokuje wykonanie
  pełnego tsc/ESLint/build/SQL. Workflow przygotowany, nie uruchomiony (GitHub403).
- Dokładne dodatnie liczniki INSERT/UPDATE pozostają nierozwiązane: raport pokazuje
  null, zamiast zawyżać wynik. Obserwacje operacji są oddzielne, jawnie opisane.
- Pobranie 63 plików Androida/workflow z b949349 do zewnętrznego snapshotu udane;
  brak zmian oryginalnej gałęzi Androida i PR #22. Integracja nastąpi osobno.

## D — import Androida i klient

- Gałąź integracyjna `feat/facebook-android-integration`; import commitem `4185dee`.
  Odtworzono i zweryfikowano podpisany SHA Androida b949349e53cb093b3ba29e6b9910f686ad565728,
  jego drzewa i 63 bloby. Oryginalna gałąź Androida wskazuje dokładny SHA; backend
  zachowany na 0aced56. PR #22 nie zmieniano. Import daje ten sam diff 58 plików.
- Klient używa ścieżek /android, posiada sync źródeł, status, diagnostykę,
  przygotowanie completion i świeży nonce przy ponowieniu dokładnego body.
- Outbox zapisuje synchronicznie zaszyfrowany rekord, nie zastępuje go po błędzie.
  Odrzuca zmianę urządzenia, nie akceptuje Bearer fallback, nie podąża za redirect.
- Dodano sesję claim/heartbeat/outbox/cancel (wyłączona domyślnie). Synchronizacja
  UI ma oddzielną bramkę false i zachowuje lokalne wyłączenia oraz tombstone.
- LIVE_COLLECTION_ENABLED=false, ANDROID_BACKEND_INTEGRATION_ENABLED=false.
  Domyślny harmonogram i executor aplikacji nadal obsługują wyłącznie DEMO.

## E — adapter offline

- Nowy izolowany OfflineDocumentCollector ładuje wyłącznie przekazany lokalny HTML,
  blokuje sieć, cookies, pliki i skrypty fixture; wstrzykuje dopiero zaufany kod.
- Gradle kopiuje dokładny collector-core.js rozszerzenia jako generowany asset.
  Nie zmieniono rozszerzenia ani nie skopiowano mechanizmów MV3.
- DOM bez strukturalnego dowodu pozostaje UNVERIFIED; zdjęcia wymagają dowodu
  powiązania rdzenia i dozwolonego CDN. Sąsiednie zdjęcia odrzucane.
- Cena/intencja/lokalizacja/pokoje nadal są interpretowane istniejącym serwerowym
  mechanizmem. Lokalny test „260 tyś.” daje 260000, 42 m2, 2 pokoje, Łódź.
- Testy Node adaptera: 5 PASS; test rzeczywistego WebView przygotowany, niewykonany.

## F — źródła i kontynuacja

- Test podpisanego API na 11 grupach i 2 profilach z mockowaną bazą: PASS.
  Obejmuje niedostępny profil, pusty wynik, duplikaty, utratę odpowiedzi,
  anulowanie, wygaśnięcie lease i kontynuację pozostałych źródeł.
- Nowy WindowContinuation w Kotlinie zachowuje kolejność i zbiór zakończonych ID,
  ogranicza cykl do 8 min, rezerwuje 15 s na finalizację, sprawdza okno,
  ekran, Wi-Fi/ładowanie, temperaturę i baterię. Testy JVM przygotowane, niewykonane.
  Nie jest jeszcze połączony z produkcyjnym WorkManagerem ani trwałym kursorem.
- Łączny offline zestaw Node: 6+52=58 PASS. Nie jest to Android/PostgreSQL E2E.
- Próba Gradle z osobnym GRADLE_USER_HOME: pobranie dystrybucji zablokowane
  SocketException Operation not permitted. Nie ma nowego APK ani wyniku Kotlin.

## G/H — scenariusz systemowy, PostgreSQL i APK w CI

- Przygotowano ręczny workflow facebook-android-system-e2e.yml (contents:read,
  timeout45min). PostgreSQL16 i ephemeral HTTPS działają wyłącznie na loopback.
- Testowy bridge DB wykonuje rzeczywiste RPC draftu, nonce w PostgreSQL,
  atomowy upsert unikalnych testowych listingów i trwały checkpoint batcha.
  Nie importuje klienta Supabase ani nie czyta sekretów produkcji.
- Testowy HTTPS API używa rzeczywistych handlerów, HMAC, normalizacji, istniejącej
  ekstrakcji/intencji i jakości; persystencja to osobny schemat testowy, a nie
  pełny pipeline persistListing/filtrów Findera. Te ostatnie nadal mają osobne
  regresje z mockami. Nie uznajemy takiego testu za pełną zgodność całej produkcji.
- Instrumentacyjny LoopbackSystemE2ETest ma przepływ: Kotlin client → HTTPS/HMAC →
  PostgreSQL queue → prawdziwy offline WebView/fixture → normalizacja → SQL zapis →
  receipt/quality/status → identyczne ponowienie bez nowej oferty. Wymaga jawnego
  argumentu testowego https://10.0.2.2:55441; inaczej jest SKIP, nie PASS.
- Workflow wykonuje kompilację/JVM/Android16, kontrolę APK i upload dopiero po
  sukcesie. Do APK nie trafia prywatny klucz testowego HTTPS; publiczny certyfikat
  dotyczy wyłącznie APK instrumentacyjnego i generowany jest w CI.
- Wersja integracyjna: 0.5.0-offline; applicationId debug .integration, aby nie
  zastępować ani produkcji, ani APK .debug Claude. Żadne dane telefonu nie są
  usuwane. Obie bramki BuildConfig pozostają false. LIVE nie dostaje fallbacku DEMO.
- Kontrole składni Python/Node/YAML i diff --check PASS. Nie wykonano Gradle,
  emulatora, SQL lub systemowego E2E. Zapis nowej gałęzi GitHub ponownie HTTP403.
- Lokalne powtórzenie: 84 backend +242 regresje +58 offline/core =384 PASS.

## D/G — dodatkowa ochrona domen danych

- Complete/failed/cancelled wymaga dataMode=LIVE na publicznym API. DEMO,
  OFFLINE_TEST i brak pola są odrzucane przed rezerwacją/importem.
- Testowy serwer CI jawnie wymaga OFFLINE_TEST, a klient tego trybu akceptuje
  tylko loopback. Nie istnieje produkcyjny env przełączający route na dane demo.
- Dodano regresję podpisanych requestów: trzy złe domeny, zero importów/rezerwacji.
- Ta zmiana kontraktu wymaga klienta z aktualnej gałęzi integracyjnej; Android
  b949349 nie jest zgodny z endpointami ani formatem nowego complete.

## F — trwała kontynuacja (kolejny checkpoint)

- EncryptedWindowCursorStorage zapisuje synchronicznie osobne kursory DEMO/LIVE
  i blokuje utratę już zakończonych ID. Zmiana okna tworzy nowy kursor.
- WindowCycleController wznawia źródła po restarcie, usuwa odebrane uprawnienia,
  konsumuje źródło wyłącznie po terminalnym receipt (także błędzie źródła),
  a niejednoznaczny import zatrzymuje do uzgodnienia. Globalny mutex wyklucza
  równoległe cykle; offline WebView ma dodatkowy globalny mutex.
- Limit pracy to 8 min minus 35 s rezerwy na maksymalnie 30-sekundową finalizację.
  Monitor co 2 s zatrzymuje zadanie po zmianie warunków ekranu/Wi-Fi/ładowania/
  baterii/temperatury/okna. Per-source limit 3 min ograniczony końcem okna.
- Nowe testy JVM opisują restart po 7 źródłach, pozostałe 6, błąd jednego źródła
  i brak konsumowania źródła po niejednoznacznym imporcie. NIEWYKONANE lokalnie.
- Kontroler pozostaje niepodłączony do istniejącego produkcyjnego harmonogramu;
  aplikacja nadal domyślnie wykonuje DEMO. Wymaga testu Kotlin i integracji
  uruchamiania kolejkowego cyklu przed przyszłym LIVE.

## C/D — końcowy przegląd scope i receipt

- Scope ma FK watched_group_id z ON DELETE CASCADE; claim sprawdza aktualne
  enabled/access_status rejestru. Usunięte i UNAVAILABLE źródła nie dostają
  nowych claimów. Przygotowano regresje PostgreSQL (łącznie 13 testów), niewykonane.
- Outbox zwraca zapisany receipt do sesji. Błąd osobnego odczytu diagnostyki po
  sukcesie nie może tworzyć nowej próby failed dla już zakończonego zadania.
- Nadal trzeba spiąć receipt/outbox z kursorem cyklu i lokalnym wyborem źródeł
  atomowo na poziomie aplikacji; awaria między receipt a zapisem kursora wymaga
  testu integracyjnego. Nie aktywowano automatu ani LIVE.

## I — przekazanie, ryzyka i artefakty

- Pełny kontrakt API z dataMode i scope, aktualny raport testów, lokalny draft PR
  i instrukcja instalacji/CI/ograniczeń Android16/kosztów/rollback/przyszłego skanu
  są zapisane w docs. Szczegóły: facebook-android-integration-handoff.md.
- GitHub create branch dla integracji zwrócił HTTP403. Brak nowego PR, runu CI
  i APK. PR #22 zachowano. Nie próbowano innych tożsamości ani obejść uprawnień.
- Nowe workflow reagują na workflow_dispatch lub ręczną etykietę
  run-facebook-android-tests na Draft PR (umożliwia uruchomienie bez merge do main).
- Końcowe wyniki lokalne: 85 backend +242 regresje +58 offline/core =385 PASS.
  Są to testy Node z mockami/fasadą DOM. Nie wykonano pełnego tsc/ESLint/build,
  SQL ani Kotlin/JVM/emulatora/systemowego E2E/APK.
- Nie deklarujemy ukończenia całego celu. Otwarte: dokładne atomowe liczniki
  produkcyjnego pipeline, pełny schemat migracji/RLS, pełna persystencja Findera
  w E2E, spięcie automatu z outboxem/kursorem i lokalnym wyborem źródeł oraz
  wszystkie niewykonane kontrole CI. Samo zatwierdzenie sesji FB nie wystarczy.
- Dodatkowe usługi utworzone: 0; nowy CI uruchomiony: 0; Vision: 0; skany: 0.
- Odtworzenie: pakiet /workspace/facebook-android-integration-delivery.tar.gz
  zawiera pełne patche main→HEAD i 88f2225→HEAD, kod zmian w Git pack,
  manifest commitów, dokumentację, logi i instrukcję. Nie zawiera pyc, cookies,
  danych sesji, plików .env ani prywatnych kluczy testowego HTTPS.

## D — przegląd parowania

- Rejestracja z helpera Androida podaje ANDROID_WEBVIEW. Gdy integracja zostanie
  kiedyś włączona, UI wymaga podpisanego device/status; stary Bearer handshake
  importu ręcznego nie jest dowodem autoryzacji Watchera. Nie migrujemy istniejących
  urządzeń Chrome. Claim klienta sprawdza consumer/jobType/imageMode odpowiedzi.
- Zmiany Kotlin pozostają niewykonane w CI; flagi false, bez wywołań produkcji.

## 0.6 — checkpoint: engine wiring (in progress)

- Continue from remote f09e6cd (local equivalent 8c899ab); preserve original ZIP.
- Added OFFLINE_TEST automation using scoped queue claims, encrypted single-record
  active job/outbox/cursor/source preferences/results journal and receipt-before-clear.
- Hooked the existing AutoScanWorker to the explicit loopback fixture configuration;
  8 minute budget, serialized WebViews, charging/Wi-Fi/battery/thermal checks and
  same-window continuation. DEMO and production paths remain separate.
- Added debug diagnostics and local source toggles. LIVE and production integration
  flags remain false. Only pinned HTTPS loopback fixture uses OFFLINE_TEST requests.
- Added transactional fixture counters, binding checks, no-op duplicate detection,
  SQL selection/concurrency tests, JVM recovery tests and full 13-source E2E scenario.
- Local Node checkpoint: 87 backend +243 regressions +58 offline/core =388 PASS.
  New Kotlin/PostgreSQL/emulator/build checks are pending CI; not yet claimed PASS.
- Local HTTPS proxy remains unavailable, so dependencies/Gradle/PostgreSQL are
  verified through the isolated Actions workflows, not a production environment.

### 0.6 checkpoint: first CI and race review

- Remote snapshot b4e42f2b616487b83a74fe5131d6f45b2f265591 has tree
  6ccc72667cf3bb0f4f6d898de81766eb53a4f7ed (local 656abf0).
- TypeScript, ESLint, full Next build and Node suites PASS in backend job
  116417165417. Kotlin compilation and JVM tests PASS in APK job 116417112605.
- PostgreSQL: 15/16 passed; one privilege assertion still named the previous
  two-argument function OID. Updated the assertion to the scoped signature.
- Made source sync/toggles atomic in the same encrypted journal, validated corrupt
  group state fail-closed, and added heartbeat-loss/domain-corruption regressions.
- Added docs/facebook-android-0.6-offline.md with pinned local HTTPS/adb setup,
  continuation, recovery semantics, transactional fixture counters and LIVE gaps.
- Remaining CI results are pending; no production actions performed.

### 0.6 checkpoint: full validation and runtime stop

- Remote c5258fd4966da5f048d35a8125d5c2c9145b59e1: isolated validation workflow
  38734070082 PASS (TypeScript/ESLint/Next build/Node/PostgreSQL 16 tests).
- APK workflow 38734070141 PASS, including Kotlin/JVM and side-by-side identity.
- Full E2E and emulator for this checkpoint are still running.
- Added one shared runtime job handle: UI stop interrupts the background cycle too;
  disabling fixture cancels pending continuation without deleting recovery data.
  Configuration cannot be changed during a running cycle.
- Added Wi-Fi-loss/API-reconnect regression asserting only unfinished sources resume.
- These final runtime changes require another CI run before being called verified.

### 0.6 checkpoint: E2E fixture isolation

- The 13-source Android/API/PostgreSQL test itself passed in workflow 38734070376,
  but its fixture configuration leaked into following DEMO WorkManager tests,
  causing two legacy assertions to fail. This was not a production or SQL failure.
- Added finally cleanup to disable the fixture for every exit path. The repeat
  cycle now uses actual AutoScanWorker with a real allowed window, emulator Wi-Fi
  and charging/battery conditions; it asserts WINDOW_COMPLETE and 9 duplicates.
- Previous full backend validation and APK/JVM remain green; revised instrumented
  scenario requires another isolated emulator/E2E run before claiming completion.
