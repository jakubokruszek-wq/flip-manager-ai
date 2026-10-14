# Flip Collector (Android MVP)

Natywna aplikacja do ręcznego przekazywania postów Facebooka do prywatnego Flip Managera.
Nie przechowuje loginu, hasła, ciasteczek ani sesji Facebooka. Działa przez systemowe **Udostępnij**.

## Konfiguracja

1. W Vercel ustaw wyłącznie serwerową zmienną `FLIP_COLLECTOR_PAIRING_SECRET`.
2. Zastosuj migrację `20260719133000_create_collector_mvp.sql` w Supabase SQL Editor.
3. Lokalnie utwórz `android/flip-collector/gradle.properties.local` lub podaj Gradle właściwość:

   ```powershell
   .\gradlew assembleDebug -PFLIP_MANAGER_BASE_URL=https://twoj-projekt.vercel.app
   ```

4. Na telefonie uruchom aplikację, wpisz adres HTTPS Flip Managera i jednorazowy sekret parowania. Sekret nie jest zapisywany przez aplikację.
5. W Samsungu ustaw: **Ustawienia → Aplikacje → Flip Collector → Bateria → Bez ograniczeń**.
6. W Facebooku użyj **Udostępnij → Flip Collector**, uzupełnij cenę i metraż, a następnie wyślij.

Token zwrócony podczas parowania jest jednorazową odpowiedzią API. Aplikacja przechowuje go przez Android Keystore / `EncryptedSharedPreferences`; baza przechowuje wyłącznie SHA-256 tokenu.

`NotificationListenerService` i widok „Facebook → Do weryfikacji” celowo nie są jeszcze aktywne: zostaną dodane dopiero po ręcznym teście importu na urządzeniu.

## Facebook Watcher (tryb demo)

Ekran „Otwórz Facebook Watcher” ma cztery zakładki: Pulpit, Harmonogram, Grupy, Historia. Ustawienia, grupy, historia i diagnostyka są zapisywane tylko w telefonie (SharedPreferences), bez płatnych usług.

- **Pulpit:** stan Wi-Fi, ładowania i baterii, przyciski „Skanuj teraz” i „Zatrzymaj”, pasek „Grupy x/y” i postów w grupie, liczniki ofert, postów i błędów, ostatni udany skan, wyniki dnia.
- **Harmonogram:** automat (domyślnie wyłączony), okno (domyślnie codziennie 02:00–05:00, Europe/Warsaw), dni, wymóg Wi-Fi i ładowania, limity czasu, powiadomienia, symulacja błędu demo, motyw (Jasny — domyślny, Systemowy, Ciemny).
- **Grupy:** wszystkie aktywne albo jedna; lista lokalna. Pobieranie z Flip Managera czeka na kontrakt backendu.
- **Historia:** skany z wynikiem, raport per grupa, powód zatrzymania; diagnostyka z kopiowaniem do schowka.

**Tryb demo** (jedyny w tej wersji) skanuje grupę testową z 12 fikcyjnymi postami oznaczonymi „DEMO”. Ręczny skan demo działa w pełni lokalnie: bez parowania, Wi-Fi, ładowarki i bez wywołań API. Automat w trybie demo stosuje okno, Wi-Fi i ładowanie z harmonogramu, żeby dało się przetestować harmonogram. Skanowanie na żywo wymaga dodatkowo `BuildConfig.LIVE_COLLECTION_ENABLED` (false), osobnej zgody na sesję Facebooka, parowania z Flip Managerem i aktywnej grupy (`ScanPreconditions`).

Praca w tle i Android 16: [`docs/android-16-praca-w-tle.md`](docs/android-16-praca-w-tle.md). Plan testów na S25 FE: [`docs/test-samsung-s25fe.md`](docs/test-samsung-s25fe.md).

Kontrast kolorów obu motywów sprawdza test `FlipPaletteContrastTest` (WCAG: 4,5:1 dla tekstu, 3:1 dla obramowań).

### Podpisane żądania

`collector/CollectorSigner.kt` to port `features/collector/protocol.ts`: klucz HMAC = hex SHA-256 tokenu, podpis HMAC-SHA256 z `timestamp\nnonce\nMETODA\nścieżka\nsha256(body)`, nagłówki `x-flip-collector-*`. Testy porównują wynik z wektorami wygenerowanymi przez serwerowy `protocol.ts`. Każde podpisane żądanie odświeża heartbeat urządzenia na serwerze, dlatego `SignedCollectorClient` niczego nie wysyła przy zamkniętej bramce.

### Budowanie

APK buduje workflow `.github/workflows/android-collector-apk.yml` (`compileDebugKotlin`, `testDebugUnitTest`, `assembleDebug`) i publikuje je jako artefakt GitHub Actions. Wersja testowa ma `applicationId` `pl.jakubokruszek.flipcollector.debug` i nazwę „Flip Collector (test)”, więc instaluje się obok wersji produkcyjnej. Lokalnie: `./gradlew testDebugUnitTest assembleDebug`.
