# Android Watcher — przekazanie i granice walidacji

Nie jest to wydanie gotowe do LIVE. Są lokalne commity integracyjne i ręczne CI,
ale brak wykonanego pełnego buildu, SQL, testów Kotlin/emulatora i nowego APK.
Wszystkie nowe bramki są wyłączone. Nie zmieniono produkcji ani filtra Flip.

## Co jest połączone

Klient Kotlin używa oddzielnych endpointów Androida, HMAC i nonce, pełnego
snapshotu uprawnionych źródeł, heartbeat, statusu, diagnostyki i completion.
Outbox zapisuje dokładne bajty przed wysłaniem, a backend przechowuje rezerwację
i receipt. Anulowanie nie zastępuje wysłanej paczki. OFFLINE_TEST nie jest
akceptowany na publicznym API. DEMO nie używa API ani outboxa.

Źródła wymagają jawnych uprawnień urządzenie/źródło/filtr. Sam token parowania
nie daje dostępu do wszystkich 13 aktywnych źródeł. Usunięte źródła są lokalnie
oznaczane, a lokalny przełącznik pozostaje po synchronizacji. Nie zakładamy,
że historyczny błąd profilu można naprawić przez zmianę statusu w produkcji.

Adapter lokalnego HTML uruchamia dokładny rdzeń rozszerzenia bez Chrome MV3.
DOM bez dowodu pozostaje UNVERIFIED; zdjęcia sąsiedniego posta nie są dołączane.
Cena, intencja, metraż, pokoje i lokalizacja używają istniejącej logiki serwera.

## Jak uruchomić przygotowane CI

Po odtworzeniu gałęzi z pakietu przez uprawnionego właściciela repozytorium:

Nowe workflow_dispatch może wymagać pliku na domyślnej gałęzi GitHub. Bez merge
można uruchomić te same joby ręcznie: po przeglądzie Draft PR właściciel dodaje
etykietę `run-facebook-android-tests`. Samo otwarcie/synchronizacja PR nie uruchamia
nowych workflow walidacyjnych; reagują tylko na tę etykietę lub workflow_dispatch.

1. Actions → **Facebook Android isolated validation** → Run workflow na gałęzi
   integracyjnej. Wykonuje npm ci, pełny tsc, ESLint, Next build, zestawy Node
   i PostgreSQL16. Nie wymaga sekretów Supabase ani Vercel.
2. Actions → **Facebook Android offline system and APK** → Run workflow.
   Tworzy bazę testową, lokalne HTTPS z jednodniowym certyfikatem, kompiluje
   Androida, wykonuje JVM i testy emulatora API36 oraz sprawdza APK.
3. Sprawdzić raporty JUnit, szczególnie LoopbackSystemE2ETest. Bez jawnego
   argumentu isolatedApiOrigin test jest SKIP. Główny systemowy workflow ten
   argument podaje; zwykły workflow Androida go nie podaje.
4. Artefakt `flip-collector-offline-validated-<sha>` powstaje tylko po sukcesie
   całego systemowego joba. Nie podajemy linku do nieistniejącego APK.

CI ma read-only permissions, limity czasu, nie ma harmonogramu, deploymentu,
sekretów produkcji ani prawdziwego Facebooka. Nie podłączać do niego produkcyjnej
bazy. Runner SQL odmawia przyjęcia dowolnego URL bazy; cel jest stałym serwisem CI.

## Instalacja APK po udanym CI

- Wersja: 0.5.0-offline. Testowy applicationId:
  `pl.jakubokruszek.flipcollector.integration`; instaluje się obok produkcji
  i `.debug` Claude. Dane tych aplikacji pozostają oddzielne.
- Pobierz APK wyłącznie z udanego runu i porównaj SHA256 z logiem kontroli APK.
- Instalacja ręczna lub `adb install path/app-debug.apk`. Nie używaj uninstall,
  opcji wymuszających downgrade ani czyszczenia danych istniejącej aplikacji.
- Kolejny debug APK z innego runnera może mieć inny klucz podpisujący. Jeśli
  system odrzuci aktualizację, zachowaj dotychczasowe dane; nie obchodź podpisu.
  Stały klucz przyszłych wydań wymaga osobnego ustalenia, nie zapisujemy go w repo.
- LIVE_COLLECTION_ENABLED=false i ANDROID_BACKEND_INTEGRATION_ENABLED=false.
  Po instalacji dostępny pozostaje DEMO; nie ma automatycznego logowania do FB.

## Macierz bezpieczeństwa i regresji

| Własność | Dowód lokalny | Brakujący dowód |
|---|---|---|
| HMAC/raw UTF-8/nonce/replay | testy protokołu i handlera PASS | wykonanie Kotlin → HTTPS CI |
| Owner/lease/fencing/checkpoint | testy RPC z mockami PASS | PostgreSQL wyścigi/RLS w CI |
| Deduplikacja i historia Findera | rzeczywisty persistListing z mockiem bazy PASS | pełna persystencja na aktualnym schemacie |
| Zdjęcia/tożsamość | adapter i 52 testy rdzenia PASS | prawdziwy WebView na API36 |
| 11 grup +2 profile | podpisana symulacja Node PASS | cykl Androida po restarcie procesu |
| DEMO/LIVE/OFFLINE_TEST | publiczny handler odrzuca błędne domeny PASS | emulatorowy E2E w CI |
| Data-only bez Vision | izolacja rzeczywistego helpera asynchronicznego PASS | test całej aplikacji w CI |
| Osiem minut i kontynuacja | kod kursora i testy JVM przygotowane | wykonanie JVM, WorkManager i Samsung |

## Pozostałe ryzyka i prace

1. Pełny checkout i zależności nie są dostępne lokalnie; tsc, ESLint i Next build
   nie wystartowały. Kod Kotlin i Gradle może wymagać poprawek po pierwszym CI.
2. Draft SQL nie był wykonany. Przygotowane testy używają minimalnych tabel
   zależnych; nie dowodzą zgodności całej historii migracji ani wszystkich
   polityk RLS aktualnego projektu. Przed promocją draftu potrzebna jest
   weryfikacja pełnego schematu na izolowanej kopii bez danych i sekretów produkcji.
3. Dokładne dodatnie liczniki fizycznych INSERT/UPDATE nie są rozwiązane dla
   produkcyjnego pipeline. Raport uczciwie zwraca null i oddziela obserwacje
   operacji. Atomowe liczniki adaptera testowego nie są dowodem naprawy produkcji.
4. Systemowy E2E ma prawdziwą kolejkę/PostgreSQL i istniejącą ekstrakcję, ale
   własny izolowany adapter persystencji. Nie zastępuje E2E całego Findera.
5. WindowCycleController i AndroidQueueSession są modułami wyłączonymi domyślnie.
   Nie podłączono ich do automatycznego WorkManagera aplikacji. Potrzebne jest
   spięcie uruchamiania z zapisanym kursorem i aktualnymi uprawnieniami oraz
   wykonanie testów restartu, temperatury i zmiany okna przed przyszłym LIVE.
   Trzeba także uzgodnić atomowy zapis receipt/kursora i walidować claim wobec
   lokalnego wyboru źródeł; te moduły nie stanowią jeszcze gotowego automatu.
6. Niejednoznaczny częściowy import pozostaje zablokowany do uzgodnienia.
   Nie ma automatycznego porzucania rezerwacji ani kasowania outboxa po błędzie.
7. GitHub odrzuca zapis HTTP403. Nie opublikowano gałęzi, PR ani workflow i nie
   uruchomiono nowych runów CI. Oryginalny PR #22 pozostaje bez zmian.

## Android 16 i fizyczny Samsung

WorkManager może opóźnić uruchomienie przez Doze, standby, limity zadań i politykę
baterii Samsunga. Okno 02:00–05:00 nie gwarantuje startu o 02:00. Skan DEMO o
02:03 potwierdza wyłącznie działanie DEMO. Nie dowodzi działania prawdziwego
WebView przy wygaszonym ekranie. LIVE pozostaje blokowane przy screen-off.
Nie używamy obejścia kwot, wybudzania telefonu, CAPTCHA ani challenge.

Kontroler ma pojedynczy cykl i pojedynczy WebView, rezerwę 35 s na finalizację
oraz monitoring warunków co 2 s. Te ograniczenia wymagają jeszcze pomiarów na
emulatorze i Samsungu; nie podajemy niewykonanych pomiarów jako wyników.

## Koszty i limity

Dodatkowe usługi utworzone: 0. Wywołania Vision i skany Facebooka: 0.
Nowe runy CI z tej sesji: 0 z powodu HTTP403. Zatem nie zmierzono zużycia CI.
Przygotowane joby mają limity 25 min (backend), 15 min (SQL), 45 min (system).
Standardowe runnery publicznego repozytorium zwykle mieszczą się w darmowych
zasadach GitHub, ale przed uruchomieniem należy sprawdzić dostępny limit konta.
Nie włączać płatnych minut ani zmieniać billing. Raporty/APK mają retencję 7 dni
w nowym workflow systemowym. Nie wprowadzono usług ani konfiguracji płatności.

## Rollback

Obecnie wystarczy zachować bramki false i korzystać z pierwotnych gałęzi/APK.
Nie ma wdrożonych zmian produkcyjnych do cofnięcia. Nie kasować outboxa/kursora.
Po ewentualnej przyszłej aktywacji najpierw wyłączyć nowe claimy, uzgodnić aktywne
lease i receipt, a dopiero potem wycofywać kod. Nie usuwać kolumn rezerwacji,
checkpointów ani uprawnień przy nierozstrzygniętym imporcie. Migracja rollback
wymaga osobnego przeglądu i zgody; nie wykonujemy jej na produkcji.

## Pierwszy kontrolowany skan — wyłącznie plan przyszłego użycia

1. Najpierw zamknąć wszystkie brakujące dowody powyżej, w tym dokładne liczniki,
   pełny schemat i integrację automatu. Sesja FB nie jest jedyną pozostałą pracą.
2. Przeprowadzić udane, powtarzalne E2E offline z PostgreSQL i zachowaniem danych
   historycznych, a następnie test instalacji APK oraz restartu na Samsungu.
3. Uzyskać osobną zgodę na sesję Facebooka i kontrolowany test. Nie zapisujemy
   teraz cookies, nie logujemy się i nie otwieramy Facebooka.
4. Wybrać jedną dostępną grupę GROUP, mały limit postów i izolowany filtr testowy.
   Nie zmieniać aktywnego filtra Flip, który obecnie nie ma źródła Facebook.
   Niedostępny profil sprawdzić oddzielnie, bez automatycznej zmiany produkcji.
5. Dopiero po przeglądzie i zatwierdzeniu nowego wydania/bramek przeprowadzić
   pojedynczy test z włączonym ekranem, Wi-Fi i ładowaniem, w data-only bez Vision.
6. Zweryfikować każdy permalink, postId, zdjęcie i cenę, stan lease, receipt i
   ponowienie bez nowego rekordu. Przy konflikcie źródła/tożsamości/zdjęcia
   zatrzymać test i zachować checkpoint; nie ponawiać importu w ciemno.

## Parowanie a autoryzacja Watchera

Urządzenie musi być zarejestrowane jako ANDROID_WEBVIEW i mieć jawne scope.
Nie wolno automatycznie zmieniać istniejącego urządzenia BROWSER_EXTENSION.
Przy włączonej w przyszłości integracji połączenie UI sprawdza podpisany
device/status; dawny Bearer currentDevice dla importu ręcznego nie potwierdza
uprawnień Watchera. Przy obecnej bramce false zachowano istniejący import ręczny,
a synchronizacja i kolejka Watchera pozostają zablokowane. Parowanie serwerowe
musi jawnie podać consumerType; zwykły stary QR rozszerzenia nie jest zgodny.
