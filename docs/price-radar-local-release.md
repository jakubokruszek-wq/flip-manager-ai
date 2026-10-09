# Radar cen po remoncie — lokalny draft release

Ten moduł nie jest aktywowany na Production. `supabase/migrations/20261008000000_create_price_radar.sql` i poniższa konfiguracja harmonogramu są wyłącznie draftami; ta praca nie łączyła się z bazą ani nie uruchamiała SQL.

## Dzienny harmonogram

Endpoint `GET|POST /api/jobs/price-radar-collect` przetwarza jedną porcję jednego właściciela (obie metody wykonują tę samą logikę — jak w każdym innym zadaniu w `app/api/jobs/`, ponieważ Vercel Cron i część darmowych harmonogramów zewnętrznych, np. cron-job.org, wywołują metodą GET). Przebieg i checkpoint pozostają w `price_radar_runs`; po wygaśnięciu lease kolejny tick przejmuje ten sam run. Proponowany termin to `15 3 * * *` w UTC. Oznacza 04:15 czasu Warszawy zimą i 05:15 latem; UTC jest stabilny i endpoint nie zależy od strefy hosta. Wpisu nie dodano do `vercel.json` i nie skonfigurowano aktywnego Supabase Cron.

Po osobnym przeglądzie wdrożenia migracji i jawnej autoryzacji można skonfigurować w Supabase Cron POST do endpointu z `Authorization: Bearer <wartość z Vault>`; sekret musi być identyczny z Production `CRON_SECRET`, przechowywany wyłącznie w Vault, a URL należy pobrać z zatwierdzonego środowiska. Nie zapisuj wartości sekretu w repo, logach ani tym dokumencie. Przed aktywacją potwierdź, że `pg_cron`, `pg_net`, Vault, wymagane tabele/kolumny/RPC i sekret istnieją. Zachowaj inne zadania i nie twórz duplikatu istniejącego Radar Cron.

Konfigurację po zatwierdzeniu można wykonać przez `cron.schedule` i `net.http_post` z nagłówkiem Authorization pobranym z Vault. Nie uruchamiaj poniższego wzorca bez podstawienia i sprawdzenia identyfikatora sekretu oraz dokładnego publicznego URL:

```sql
-- DRAFT ONLY — not executed.
-- select cron.schedule(
--   'price-radar-daily',
--   '15 3 * * *',
--   $$ select net.http_post(
--     url := '<approved-production-origin>/api/jobs/price-radar-collect',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = '<approved-vault-secret-name>'),
--       'Content-Type', 'application/json'
--     ),
--     body := '{}'::jsonb
--   ); $$
-- );
```

## Tożsamość i próbka

Wewnątrz portalu używane są źródłowe `external_listing_id` i znormalizowany URL, z przestrzenią nazw portalu. Między portalami łączenie wymaga jawnego `crossSourceIdentity` z adaptera o typie `canonical_unit_id` albo `portal_shared_unit_id`; zapisany klucz ma postać `<typ>:<wartość>`. Cena, metraż, dzielnica, liczba pokoi, tytuł, adres, zdjęcie albo ogólny URL kategorii nigdy same nie scalają ofert. To ogranicza scalanie fałszywych par, ale oznacza, że prawdziwe kopie bez jawnego stabilnego identyfikatora mogą nadal policzyć się osobno.

Średnie i mediany są zwracane dopiero od 20 zakwalifikowanych, nie wykluczonych ofert dla każdej dzielnicy, rynku i zakresu filtrów. Poniżej progu API zwraca faktyczną liczebność oraz `null` ceny referencyjnej. Daty publikacji i aktualizacji pochodzą wyłącznie ze źródła; pobranie zapisuje oddzielnie.

## Granice źródeł i OLX

Źródła Radaru są przecięciem wspólnej bramy Findera, rzeczywistego rejestru adapterów i filtrów kwalifikacji. Facebook, źródła zablokowane i nieobjęte bramą są pomijane. OLX pozostaje w istniejącej kolejce `olx_scan_jobs`, ale w kontekście `price_radar`; nie tworzy wiersza `source_scans`, filtra Findera ani członkostw. Draft migracji wprowadza kontrolowane NULL w referencjach Findera wyłącznie dla tego kontekstu, osobne ID właściciela/runu i lease-token. Claim/heartbeat/finalizacja używają fencing tokenów. Zapis wyników pozostaje w `price_radar_listings` i jest atomowo odrzucany dla wygasłego właściciela.

Test migracji wykonuje SQL w PGlite (embedded PostgreSQL), a nie w pełnym, współbieżnym serwerze PostgreSQL. Nie dowodzi równoległych wyścigów produkcyjnego PostgreSQL. Przed aktywacją harmonogramu wymagane są odrębne testy/odczyty w zatwierdzonym środowisku.
