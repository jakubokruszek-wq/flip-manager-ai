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

## Facebook Watcher → Ustawienia skanowania (tryb przygotowawczy)

Ekran z poziomu strony głównej aplikacji. Ustawienia są zapisywane tylko w telefonie (SharedPreferences), bez płatnych usług.

- Automat wł./wył. (domyślnie wyłączony), okno godzin (domyślnie codziennie 02:00–05:00, Europe/Warsaw), dni tygodnia, wymóg Wi-Fi i ładowania (domyślnie oba włączone).
- Okno przechodzące przez północ należy do dnia rozpoczęcia. W nocy zmiany czasu okno 02:00–05:00 trwa 2 h (marzec) albo 4 h (październik).
- Automat to zadanie WorkManagera co 15 min z ograniczeniami Wi-Fi/ładowania; uruchamia najwyżej jeden skan na okno.
- „Skanuj teraz” / „Zatrzymaj”, wybór jednej lub wszystkich aktywnych grup, postęp, liczniki, błędy i historia (ostatnie 50 skanów).
- Naraz działa najwyżej jeden skan (ręczny i automatyczny dzielą jedną blokadę).

**W tej wersji aplikacja nie otwiera Facebooka, nie pobiera zadań z kolejki i nie zapisuje sesji Facebooka.** Skan przechodzi przez grupy na próbę (`DryRunScanExecutor`). Zbieranie na żywo jest wyłączone na etapie kompilacji (`BuildConfig.LIVE_COLLECTION_ENABLED = false`) i dodatkowo wymaga osobnej zgody użytkownika (`LiveCollectionGate`).

### Podpisane żądania

`collector/CollectorSigner.kt` to port `features/collector/protocol.ts`: klucz HMAC = hex SHA-256 tokenu, podpis HMAC-SHA256 z `timestamp\nnonce\nMETODA\nścieżka\nsha256(body)`, nagłówki `x-flip-collector-*`. Testy porównują wynik z wektorami wygenerowanymi przez serwerowy `protocol.ts`. Każde podpisane żądanie odświeża heartbeat urządzenia na serwerze, dlatego `SignedCollectorClient` niczego nie wysyła przy zamkniętej bramce.

### Budowanie

APK buduje workflow `.github/workflows/android-collector-apk.yml` (`compileDebugKotlin`, `testDebugUnitTest`, `assembleDebug`) i publikuje je jako artefakt GitHub Actions. Wersja testowa ma `applicationId` `pl.jakubokruszek.flipcollector.debug` i nazwę „Flip Collector (test)”, więc instaluje się obok wersji produkcyjnej. Lokalnie: `./gradlew testDebugUnitTest assembleDebug`.
