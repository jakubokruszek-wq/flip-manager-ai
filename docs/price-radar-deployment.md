# Price Radar — wdrożenie PR #2 i pomiar pierwszego skanu

Ten dokument opisuje kroki po zatwierdzeniu PR #2. Nic z poniższego nie jest
wykonywane automatycznie: SQL, sekrety i skany Production uruchamia operator.

## 1. Przed połączeniem

1. PR #2 jest zielony: workflow `Price Radar CI` (TypeScript, ESLint, testy
   Radaru i źródeł, build, Playwright) oraz Vercel.
2. PR #2 łączy się z `main` bez konfliktów. Kolejność względem PR #4 (Finder)
   i PR #3 (worker OLX) jest dowolna: nie mają wspólnych plików, a testy
   Radaru przechodzą także na scaleniu PR #2 + PR #4.
3. W Vercel (Production) istnieje `PRICE_RADAR_CRON_SECRET` (już używany przez
   harmonogram GitHub). Nie trzeba dodawać nowych zmiennych:
   `VERCEL_PROJECT_PRODUCTION_URL` jest systemową zmienną Vercel, a domyślny
   adres kontynuacji to `https://flip-manager-ai.vercel.app`.

## 2. Połączenie i wdrożenie

1. Połącz PR #2 (squash). Vercel wdraża `main` na Production.
2. Sprawdź status wdrożenia commita w GitHub (`Vercel — Deployment has
   completed`, środowisko Production) oraz w PWA: Ustawienia → „Uruchomiona
   wersja” = SHA scalonego commita.
3. Nie trzeba resetować checkpointów ani migrować danych: stare checkpointy są
   czytane bez zmian (brak `progress`/`metrics` oznacza zera).

## 3. Strażnik Supabase (opcjonalny, zalecany)

Bez strażnika przebieg prowadzi się sam przez łańcuch kontynuacji na serwerze.
Strażnik wznawia go, gdy łańcuch zostanie przerwany (zabita funkcja, odrzucone
przekazanie, długi Retry-After), bez telefonu i bez harmonogramu GitHub.

1. Supabase → Vault: utwórz sekret `price_radar_cron_secret` o **tej samej
   wartości** co `PRICE_RADAR_CRON_SECRET` w Vercel. Nie zmieniaj istniejącego
   sekretu w Vercel.
2. SQL Editor: przejrzyj i wykonaj `scripts/configure-price-radar-cron.sql`
   (sprawdza `pg_cron`, `pg_net`, Vault i dokładnie jeden sekret).
3. Kontrola (tylko odczyt):
   ```sql
   select jobid, jobname, schedule, active from cron.job where jobname = 'price-radar-watchdog';
   select status, start_time, end_time from cron.job_run_details
   where jobid = (select jobid from cron.job where jobname = 'price-radar-watchdog')
   order by start_time desc limit 5;
   ```
   W logach Vercel pojawia się `RADAR_WATCHDOG_TICK` co minutę.
4. Wyłączenie: `select cron.unschedule('price-radar-watchdog');`

Strażnik niczego nie uruchamia poza tym, co robi harmonogram GitHub: wznawia
istniejący przebieg z wygasłym lease (ten sam ID i checkpoint) albo startuje
dzienny skan o zapisanej godzinie. Przy aktywnym lease nic nie robi.

## 4. Pomiar pierwszego skanu Production

Najlepiej mierzyć nowy przebieg (dzienny o zapisanej godzinie albo uruchomiony
przez operatora w PWA). Przebieg rozpoczęty przed wdrożeniem miesza starą i
nową logikę.

Podgląd w PWA: Radar → „Zbieranie Radaru” → „Wydajność przebiegu”.

Zapytanie (tylko odczyt):

```sql
select
  r.id, r.status, r.started_at, r.finished_at, r.scanned_count, r.qualified_count,
  r.checkpoint->'progress'->'metrics'->>'httpStartedAt'  as http_started_at,
  r.checkpoint->'progress'->'metrics'->>'httpFinishedAt' as http_finished_at,
  round((r.checkpoint->'progress'->'metrics'->>'httpActiveMs')::numeric / 60000, 1) as http_active_min,
  (r.checkpoint->'progress'->'metrics'->>'portions')::int as portions,
  round((r.checkpoint->'progress'->'metrics'->>'handOffGapMs')::numeric / 1000) as handoff_gap_s,
  r.checkpoint->'progress'->'metrics'->>'olxEnqueuedAt' as olx_handed_over_at,
  r.checkpoint->'progress'->'lastContinuationError' as last_handoff_error,
  r.source_statuses
from public.price_radar_runs r
order by r.started_at desc
limit 1;
```

Profil portali:

```sql
select s.key as source,
  (s.value->>'attempts')::int as attempts,
  round((s.value->>'activeMs')::numeric / 1000) as active_s,
  (s.value->>'listRequests')::int as list_req,
  (s.value->>'detailRequests')::int as detail_req,
  (s.value->>'contextRequests')::int as context_req,
  round((s.value->>'detailMs')::numeric / 1000) as detail_s,
  round(((s.value->>'dbMs')::numeric + (s.value->>'checkpointMs')::numeric) / 1000) as db_s,
  (s.value->>'fetched')::int as offers,
  round((s.value->>'fetched')::numeric / nullif((s.value->>'activeMs')::numeric / 60000, 0)) as offers_per_min
from public.price_radar_runs r,
  jsonb_each(r.checkpoint->'progress'->'metrics'->'sources') s
where r.id = (select id from public.price_radar_runs order by started_at desc limit 1)
order by active_s desc;
```

Interpretacja:

- Czas portali HTTP (cel 5–15 min, wolne portale do 25 min, twardy limit
  30 min aktywnej pracy): `http_finished_at - http_started_at` oraz
  `http_active_min`. Różnica między nimi to przerwy między porcjami
  (`handoff_gap_s`).
- OLX liczy się osobno: od `olx_handed_over_at` do zakończenia zadania
  workera.
- `last_handoff_error` różny od `null` oznacza przerwany łańcuch; jeśli
  strażnik nie jest skonfigurowany, przebieg czekał wtedy na harmonogram albo
  PWA.
- Portal z `RADAR_SOURCE_NO_PROGRESS_LIMIT` lub `RADAR_HTTP_TIME_LIMIT` w
  `source_statuses`/błędach jest uczciwie oznaczony jako częściowe pokrycie.

## 5. Wycofanie

Revert scalonego commita PR #2 w `main` (Vercel wdroży poprzednią wersję).
Checkpointy zapisane przez nową wersję są czytelne dla poprzedniej (pola
`progress`, `checkedListingKeys`, `contextValues` są przez nią ignorowane).
Strażnika wyłącza `cron.unschedule('price-radar-watchdog')`.
