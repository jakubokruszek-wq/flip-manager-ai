# Watcher 0.6 — izolowana integracja offline

## Co wykonuje APK

Panel OFFLINE TEST na ekranie Watchera używa tego samego silnika co istniejący
AutoScanWorker. Po ręcznym skonfigurowaniu fixture synchronizuje źródła, zachowuje
lokalne przełączniki, wybiera zadania dla jednego źródła, odnawia lease, odczytuje
wyłącznie dołączone HTML i wysyła podpisane paczki do lokalnego API testowego.
Nigdy nie otwiera URL źródła. Produkcyjne parowanie, DEMO, LIVE i OFFLINE_TEST nie
współdzielą outboxa ani kursora. Obie bramki produkcyjne są false.

Dziennik jest jednym rekordem EncryptedSharedPreferences (Keystore). Zawiera
aktywne zadanie, dokładne bajty outboxa, źródła i lokalne wyłączenia, kursor okna
oraz wyniki indeksowane przez completionId. Potwierdzenie serwera i przesunięcie
kursora zapisują się przed wyczyszczeniem outboxa. Utrata odpowiedzi lub restart
powodują ponowienie tych samych bajtów, a nie nowego completionId. Niejasny import
pozostaje zablokowany; aplikacja nie usuwa go ani nie omija fencing.

Limit cyklu wynosi 8 minut z 35-sekundową rezerwą na zapis. Pozostałe źródła są
kontynuowane przez pojedynczy łańcuch WorkManagera po 30 sekundach, wyłącznie w tym
samym dozwolonym oknie. Wymagane są Wi-Fi, ładowanie, bateria >=20% i bezpieczna
temperatura. Każdy tick sprawdza ponownie okno i warunki; WebView jest serializowany.
Zablokowany ekran jest dopuszczalny dla lokalnego HTML OFFLINE_TEST. Nie stanowi
to dowodu obsługi prawdziwego Facebooka przy wygaszonym ekranie.

## Lokalny fixture dla Samsunga (bez produkcji)

Wymagania: własny komputer z Dockerem, Node 24, Pythonem z psycopg i adb. Użyj
kodu gałęzi integracyjnej. Wszystkie poniższe operacje dotyczą tylko nowej lokalnej
bazy `flip_android_test` na porcie 55439. Nie podawaj zmiennych Supabase, tokenów
produkcyjnych ani cookies. Nie używaj istniejącej bazy o tej nazwie: testy kasują
schemat public lokalnego fixture.

```sh
docker run --rm --name flip-offline-pg \
  -p 127.0.0.1:55439:5432 \
  -e POSTGRES_USER=flip_test -e POSTGRES_PASSWORD=isolated-ci-only \
  -e POSTGRES_DB=flip_android_test postgres:16
```

W katalogu repozytorium, po gotowości bazy:

```sh
python -m pip install 'psycopg[binary]==3.2.6'
export FLIP_ISOLATED_TESTS=1
python scripts/test-facebook-android-postgres.py
export FLIP_TEST_TLS_KEY=/tmp/flip-fixture.key
export FLIP_TEST_TLS_CERT=/tmp/flip-fixture.pem
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$FLIP_TEST_TLS_KEY" -out "$FLIP_TEST_TLS_CERT" -days 1 \
  -subj '/CN=localhost' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:10.0.2.2'
python scripts/facebook-android-test-db.py
```

Ostatnie polecenie działa w osobnym terminalu; w następnym ustaw te same trzy
zmienne fixture/TLS i uruchom:

```sh
node --import ./scripts/test-alias-loader.mjs scripts/facebook-android-test-api.ts
adb reverse tcp:55441 tcp:55441
```

Zainstaluj APK `.integration` obok dotychczasowej aplikacji. W panelu OFFLINE TEST
wpisz `https://localhost:55441`, wklej **publiczny** certyfikat z `/tmp/flip-fixture.pem`
i połącz fixture. Nigdy nie kopiuj prywatnego klucza `.key` na telefon. Ustaw okno
harmonogramu obejmujące obecną porę, podłącz ładowanie i Wi-Fi. „Cykl offline” działa
w tym oknie; automat wymaga dodatkowo włączonego harmonogramu. Źródła i ich lokalne
przełączniki oraz wyniki są widoczne w panelu. „Zatrzymaj” przerywa ręczny cykl;
„Odłącz fixture” wyłącza następne cykle bez usuwania stanu odzyskiwania.

Fixture ma 11 grup i 2 profile, z jednym niedostępnym profilem. Źródło offline-3
jest puste, offline-5 kończy się błędem. Identyfikatory postów są deterministyczne
i oddzielne dla źródeł. Test E2E wyłącza dodatkowo lokalnie jedną grupę, odtwarza
stan po utracie odpowiedzi, a następnie ponawia wszystkie dozwolone źródła w nowym
oknie. Oczekuje 9 fizycznych ofert; ponowny cykl daje 9 duplikatów, 0 nowych i 0
aktualizacji bez zmiany ceny.

Wyłączenie fixture nie usuwa danych. Nie zmieniaj serwera/certyfikatu przy aktywnym
zadaniu lub pending outboxie. Najpierw uzgodnij wynik z tą samą bazą. Pamięć wyników
ma bezpieczny limit 500 potwierdzeń; pełna historia zatrzymuje dalszy zapis, zamiast
usuwać potwierdzenia automatycznie. Przed produkcją potrzebna jest polityka retencji.

## Granice dowodów i pierwsze LIVE

Liczniki TRANSACTIONAL są dokładne dla izolowanego adaptera PostgreSQL. Nie są
potwierdzeniem kompletnej produkcyjnej ścieżki persistence Findera. Historyczne
niezweryfikowane liczniki produkcyjne pozostają null. Żadnego draft SQL nie wykonano
na Supabase; zmiana podpisu funkcji claim wymaga przyszłego przeglądu migracji.

Przed LIVE pozostają: audyt adaptera produkcyjnego i atomowych liczników, przegląd
migracji/RLS/grantów i konfiguracji staging, osobna zgoda na sesję Facebooka,
kontrolowane sparowanie urządzenia i jedno źródło, ręczny test prawdziwego WebView
na Samsungu (ekran włączony/wyłączony, Doze, utrata Wi-Fi, bateria/temperatura),
limity i obserwacja jednej grupy oraz osobna decyzja o aktywacji obu bramek.
Tych kroków ta wersja nie wykonuje. Cofnięcie testu: odłącz fixture, wyłącz automat,
zatrzymaj lokalne procesy i kontener; żadna zmiana produkcyjna nie wymaga rollbacku.
