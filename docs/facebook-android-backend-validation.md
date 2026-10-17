# Wyniki weryfikacji — integracja Androida

Gałąź: feat/facebook-android-integration. Checkpointy:
[facebook-android-integration-progress.md](facebook-android-integration-progress.md).

## Wykonane lokalnie

- npm run test:facebook-android: **85/85 PASS** (62+12+7+4).
- npm run test:facebook-android-regression: **242/242 PASS** (239+3).
- npm run test:facebook-android-offline: **58/58 PASS** (6 adapter/cykl, 52 rdzeń).
- Łącznie **385 PASS**, brak skip/fail. Kontrole składni Python/Node/YAML
  i git diff --check także zakończone powodzeniem.
- Zweryfikowano signed commit Androida b949349, drzewa i pobrane bloby;
  kod importowano bez zmiany PR #22 i źródłowej gałęzi Androida.

Testy wykonują rzeczywiste handlery, HMAC, normalizację i ekstrakcję oraz
persistListing z mockiem Supabase. Node używa --test-isolation=none.
Ignorowany placeholder next/server służy wyłącznie rozwiązywaniu mock.module;
nie jest zainstalowanym Next i nie zastępuje kompilacji/frameworka.
Testy DOM Node mają fasadę dokumentu; rzeczywisty WebView ma oddzielny,
lokalnie niewykonany test instrumentacyjny.

## Zablokowane — bez statusu PASS

- TypeScript: brak node_modules/typescript/bin/tsc.
- ESLint: eslint: not found. Build: next: not found.
- PostgreSQL: brak initdb/pg_ctl/psql; Docker socket niedostępny.
- Gradle/JVM/APK: wrapper nie może pobrać Gradle, SocketException Operation not
  permitted. Użyto osobnego GRADLE_USER_HOME w /workspace.
- Emulator Android16 i systemowy E2E: nie uruchomiono.
- Nowe CI: przygotowano, nie opublikowano i nie uruchomiono — GitHub403.

## Przygotowane CI

facebook-android-validation.yml: pełne zależności, tsc/ESLint/build i testy
PostgreSQL16. test-facebook-android-postgres.py zawiera 13 testów transakcji,
grantów, fencing, scope i unikalności. test-facebook-android-sql.py tworzy
osobny klaster natywny bez TCP, nie przyjmuje produkcyjnego URL.

facebook-android-system-e2e.yml: Kotlin → lokalne HTTPS/HMAC → PostgreSQL queue
→ lokalny WebView HTML → istniejąca ekstrakcja → testowy upsert/checkpoint →
raport/status → ponowienie. Upload APK dopiero po sukcesie. To odrębny adapter
persystencji, nie pełne wykonanie produkcyjnego Findera.

Pełny schemat/historyczne migracje oraz dokładne dodatnie liczniki zapisów
produkcyjnego pipeline pozostają niezweryfikowane/nierozwiązane. Szczegóły:
[facebook-android-integration-handoff.md](facebook-android-integration-handoff.md).
Nie wykonano skanów, zmian produkcji/Supabase/filtra Flip/OLX, Vision,
merge ani deploymentu.
