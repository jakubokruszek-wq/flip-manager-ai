# Harmonogram Findera: izolacja OLX i pg_cron co 5 minut

## 1. Przyczyna (13.10.2026)

Filtr „Flip” obejmuje 12 źródeł, `finder_scan_interval_minutes = 300`.
- Skan wystartował o 07:30 UTC. 11 portali skończyło pracę, a OLX czekał w osobnej kolejce
  (`olx_scan_jobs`) do 20:06. Wtedy zakończył go ręczny test Cloudflare stage2.
- Przez cały ten czas nie ruszył żaden kolejny cykl pozostałych portali.

Na dzisiejszy problem złożyły się trzy mechanizmy w kodzie, a czwarty dołożyłby duplikaty:

1. **Blokada** — `finder-scheduler.ts → hasRunningFinderScan()` uznawał filtr za zajęty, gdy
   **dowolne** aktywne źródło miało wiersz `source_scans` w stanie `pending`/`running`, OLX także.
   Wiersz OLX tworzy `enqueueOlxJob` i pozostaje `pending`, dopóki osobny worker OLX nie zakończy
   zadania. Jedno czekające zadanie OLX blokowało więc wszystkie portale.
2. **Wspólny przebieg** — `startFinderScanForFilter()` ustawiał `actualRunId = olxRunId`, czyli
   dopisywał nowy cykl portali do starego przebiegu OLX. Gdy portale wznawiały inny przebieg,
   rzucał 429 „niezgodne, równoległe przebiegi”.
3. **Zegar** — `completeOlxJob()` ustawiał `search_filters.last_scanned_at = now()`, wspólny zegar
   harmonogramu wszystkich portali filtra. Spóźnione zakończenie OLX o 20:06 przesunęło następny
   cykl na 01:06 zamiast zachować rytm 300 minut od startu przebiegu.
4. **Duplikat OLX (ukryty)** — po samym odblokowaniu `runManualOtodomScan()` dodałby **drugie**
   zadanie OLX dla nowego przebiegu: `existingOlxScanResult(nowyRun)` nie widzi zadania ze starego
   przebiegu.

**Dowód:** test `13.10 regression` w `finder-scheduler-olx-isolation.test.ts` odtwarza dzień co
5 minut na prawdziwym zapytaniu blokady i prawdziwym CAS.
- Ze starą blokadą startuje tylko cykl 07:30.
- Po poprawce startują cykle 07:30, 12:30, 17:30 i 22:30.
- Nowy test w `manual-scan-lock-separation.test.ts` nie przechodzi na kodzie z `main` (sprawdzone).

## 2. Poprawka (minimalny wariant)

| Miejsce | Zmiana |
|---|---|
| `finder-scheduler.ts` | `FINDER_SCHEDULER_INDEPENDENT_SOURCES = {"olx"}`: wiersz OLX nie blokuje cyklu pozostałych portali. Ich własne wiersze `pending`/`running` nadal blokują (ochrona przed równoległym skanem). CAS `claimFinderFilter` bez zmian. |
| `manual-scan.ts → startFinderScanForFilter` | Portale wznawiają **swój** niedokończony przebieg albo rezerwują nowy (`reserve_source_scans` bez zmian). Filtr tylko z OLX nadal podąża za swoim zadaniem. Nowe zadanie OLX powstaje wyłącznie wtedy, gdy filtr nie ma żadnego zadania OLX w toku (log `FINDER_OLX_JOB_STILL_QUEUED`). |
| `manual-scan.ts → runManualOtodomScan` | To samo zabezpieczenie: przy zadaniu OLX z wcześniejszego przebiegu nie powstaje drugie. Ostrzeżenie `OLX_PREVIOUS_JOB_IN_QUEUE` trafia do wyniku, a OLX nie jest liczony do nowego przebiegu. |
| `olx-jobs.ts → completeOlxJob` | Nie zmienia `search_filters.last_scanned_at`. Zakończenie zadania, wiersz `source_scans` OLX i `result_summary` działają jak dotąd. |
| logi schedulera | `FINDER_SCHEDULER_CYCLE_START`, `FINDER_SCHEDULER_SKIPPED` (`SOURCE_SCAN_IN_PROGRESS` / `CLAIM_LOST` / `RESERVATION_LOCKED`), `FINDER_SCHEDULER_RUN_RESULT` (status, liczba ukończonych źródeł, źródła w toku), `FINDER_SCHEDULER_FILTER_FAILED` (przyczyna). Bez sekretów. |

**Awaria kolejki OLX:** dla filtra z OLX i innymi portalami `OLX_MULTIPLE_RUN_IDS` albo błąd odczytu
kolejki OLX (`OLX_QUEUE_READ_FAILED`) nie zatrzymuje pozostałych portali.
- Nie powstaje żadne zadanie OLX.
- Wynik przebiegu dostaje ostrzeżenie `olx: OLX_MULTIPLE_RUN_IDS: …` albo `olx: OLX_QUEUE_READ_FAILED: …`,
  a w logu pojawia się `FINDER_OLX_QUEUE_DEGRADED`.
- OLX nie jest liczony jako nieudane źródło.
- Filtr **wyłącznie z OLX** zachowuje dotychczasowe zabezpieczenie: 429 przy niespójnych przebiegach, 500 przy błędzie odczytu.

**Czego poprawka nie robi:**
- nie przejmuje zadania OLX i nie zmienia lease ani kolejki OLX;
- nie zmienia historii istniejących przebiegów i nie dodaje migracji;
- nie zmienia Radaru ani Facebook Watchera; wiersze `facebook` nigdy nie były blokadą Findera;
- nie zmienia limitów Cloudflare.

**Wszystkie zapisy `last_scanned_at`:**
- `claimFinderFilter` — start cyklu, CAS;
- `revertFinderFilterClaim` — cofnięcie, gdy start się nie udał;
- `runManualOtodomScan` — koniec porcji, sekundy po starcie;
- `completeOlxJob` — **usunięty**;
- Facebook Watcher ma osobny `scan_interval_minutes`, bez zmian.

**Dlaczego nie pełna izolacja:** osobny zegar na każde źródło wymagałby migracji i zmiany modelu
przebiegu. Obecny wariant usuwa blokadę, duplikaty i przesunięcie zegara bez zmian schematu.

**Uwaga na przyszłość:** zadanie OLX, które nigdy nie zostanie odebrane, nadal blokuje
**kolejne zadania OLX** tego filtra (to celowe: brak duplikatów). Nie blokuje już portali. Polityka
wygaszania bardzo starych zadań OLX to osobna decyzja.

## 3. pg_cron: z 1 na 5 minut (osobna zgoda)

Teraz na Production oba zadania mają `* * * * *`, czyli 2880 wywołań na dobę. Szkic
`scripts/configure-finder-cron.sql` zakładał `*/5`. Docelowo będzie 576 wywołań na dobę.
Częstotliwość wywołań schedulera to **nie** częstotliwość skanów: każdy filtr skanuje się według
`finder_scan_interval_minutes` (Flip: 300).

Kolejność:
1. Scal PR (Vercel Production) i sprawdź SHA przez `/api/build-info`. Kod działa poprawnie przy obu
   częstotliwościach.
2. Supabase → SQL Editor: uruchom `scripts/finder-cron-every-5-minutes.sql`.
   - Zmienia wyłącznie harmonogram dwóch zadań (`cron.alter_job`), nie dotyka komend ani sekretów.
   - Przerywa bez zmian, gdy któregoś zadania brak albo jest zdublowane.
   - Na końcu sprawdza wynik.
3. Kontrola (tylko odczyt):
   ```sql
   select jobname, schedule, active from cron.job order by jobname;
   select j.jobname, d.status, d.start_time from cron.job_run_details d join cron.job j using (jobid)
    where j.jobname in ('finder-scan-scheduler','finder-scan-continuation') order by d.start_time desc limit 10;
   ```
4. **GitHub Actions jako drugi sterownik:** zaplanowane przebiegi `finder-scan-scheduler.yml` /
   `finder-scan-continuation.yml` faktycznie się wykonują (np. przebieg 38462172134, 20:21 UTC,
   krok „Start due Finder scans”). Zmienna `FINDER_SCHEDULER_DRIVER` nie jest więc ustawiona na
   `supabase-cron`.
   - Blokady (CAS + `reserve_source_scans`) wykluczają podwójny skan, ale to zbędny drugi sterownik.
   - Po potwierdzeniu pg_cron ustaw w repo **Settings → Secrets and variables → Actions → Variables**:
     `FINDER_SCHEDULER_DRIVER = supabase-cron`.
   - `workflow_dispatch` zostaje jako ręczny sterownik zapasowy.

**HTTP 202 i status `succeeded` w `cron.job_run_details` oznaczają tylko doręczenie żądania**
(test `finder-scheduler-route.test.ts`). Rzeczywisty wynik jest w logach Vercel
(`FINDER_SCHEDULER_*`) i w `source_scans`.

## 4. Sprawdzenie w Production (tylko odczyt)

```sql
-- Przebiegi filtra Flip: każdy cykl portali powinien startować co ~300 min, niezależnie od OLX.
select scan_run_id, min(started_at) as started, count(*) filter (where status = 'completed') as completed,
       count(*) filter (where status in ('pending','running')) as in_progress, string_agg(distinct source, ',') as sources
  from public.source_scans s join public.search_filters f on f.id = s.search_filter_id
 where f.name = 'Flip' and s.started_at > now() - interval '2 days'
 group by scan_run_id order by started desc;

-- Kolejka OLX filtra: najwyżej jedno zadanie w toku.
select status, count(*) from public.olx_scan_jobs j join public.search_filters f on f.id = j.search_filter_id
 where f.name = 'Flip' and j.context_type = 'finder' group by status;

-- Zegar filtra.
select name, last_scanned_at, finder_scan_interval_minutes from public.search_filters where name = 'Flip';
```

W logach Vercel (Functions) szukaj `FINDER_SCHEDULER_RUN_RESULT`: `sourcesCompleted` i
`pendingSources`. Cykl, który czeka tylko na OLX, ma `pendingSources: ["olx"]` w przebiegu z OLX;
nowe przebiegi dostają `OLX_PREVIOUS_JOB_IN_QUEUE`.

## 5. Wycofanie

- **Kod:** revert commita PR w GitHub (przycisk *Revert*), a następnie wdrożenie. Schemat ani dane
  się nie zmieniły, więc wystarczy revert.
- **pg_cron:** `scripts/finder-cron-every-5-minutes.rollback.sql` (powrót do `* * * * *`).
- **GitHub Actions:** usuń zmienną `FINDER_SCHEDULER_DRIVER`, aby przywrócić zaplanowane przebiegi.

## 6. Testy

| Plik | Co potwierdza |
|---|---|
| `finder-scheduler-olx-isolation.test.ts` | regresja 13.10 (stara blokada: 1 start); OLX czeka 12 h, portale co 300 min (07:30/12:30/17:30/22:30); ticki co 5 min pomijają filtr jako niewymagalny; późne OLX nie przesuwa zegara; jedno zadanie OLX naraz; wiersz `pending`/`running` innego portalu blokuje; dwa równoczesne wywołania → jeden start; Facebook nie blokuje; logi bez sekretów |
| `manual-scan-lock-separation.test.ts` (+4) | nowy cykl dostaje nowy przebieg, bez drugiego zadania OLX i bez zmian w starych wierszach; po zakończeniu OLX powstaje dokładnie jedno nowe; wznowienie tego samego przebiegu; filtr tylko z OLX |
| `olx-resumption.test.ts` (+1) | zakończenie OLX o 20:06 nie zmienia `last_scanned_at` |
| `finder-scheduler-route.test.ts` | 202 przed wykonaniem cyklu, wynik tylko w logach; 401 bez pracy |
| `finder-cron-every-5-minutes.test.ts` | SQL na PostgreSQL (PGlite): zmienia tylko 2 zadania Findera, komendy bez zmian, idempotentny, przerywa przy braku lub duplikacie zadania, rollback; 576 vs 2880 |
