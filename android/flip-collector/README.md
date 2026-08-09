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
