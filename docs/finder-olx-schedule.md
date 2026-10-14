# Finder: osobny harmonogram OLX, budżet Cloudflare i pg_cron co 5 minut

Stan: **kod gotowy, nic nie wdrożono.** Migracja, SQL pg_cron i zmienna GitHub wymagają osobnej zgody.
Worker Cloudflare stage2 pozostaje wyłączony (`OLX_CLOUD_ENABLED="0"`, tryb `manual`). Ten PR go nie zmienia.

## 1. Co się zmienia

| Przed | Po |
|---|---|
| OLX był zlecany razem z cyklem portali (`finder_scan_interval_minutes`, Flip: 300 min). Jedyną ochroną było „nie więcej niż jedno zadanie OLX w toku”. Po zakończeniu zadania każdy kolejny cykl, czyli co 5 h, zlecał nowe. | Automatyczny scheduler **nigdy** nie zleca OLX w cyklu portali. OLX ma własny, trwały interwał `search_filters.finder_olx_scan_interval_minutes`: 24 h (domyślnie), 48 h albo 72 h. |
| Brak limitu wspólnego dla kilku filtrów i dla Radaru. | Jedna funkcja SQL decyduje centralnie, pod jedną blokadą: najwyżej **1 automatyczne zadanie OLX na 24 h dla wszystkich filtrów** i wspólny budżet zadań OLX liczony razem z ręcznymi skanami i Radarem cen. |
| Interwał OLX niewidoczny. | Pole „Interwał OLX” w ustawieniach filtra z informacją o limicie Cloudflare i diagnostyką: ostatnie zlecenie, następny termin, powód pominięcia, liczby zadań. |

Niezmienione: częstotliwość skanowania pozostałych 11 portali (300 min) i ręczny przycisk „Skanuj” (nadal
dodaje OLX, jeśli żadne zadanie OLX nie czeka). Bez zmian zostają też Radar cen, Facebook Watcher,
kolejka OLX i jej workery, lease oraz worker Cloudflare.

## 2. Model danych — najmniejsza bezpieczna zmiana

Migracja `supabase/migrations/20261014120000_add_finder_olx_schedule.sql` (szkic, **do ręcznego zastosowania**):

1. `search_filters.finder_olx_scan_interval_minutes integer not null default 1440` + `check (>= 1440)`.
   - Baza odrzuca interwał krótszy niż 24 h. Krótszy wymaga osobnej migracji razem z przeglądem budżetu.
   - Aplikacja przyjmuje tylko 1440, 2880 i 4320.
2. `olx_scan_jobs.requested_by text null`, z wartością `'scheduler'` dla zadań automatycznych.
   - Ręczny Finder i Radar nadal wpisują NULL, a ich kod się nie zmienia.
3. Indeksy `olx_scan_jobs (created_at desc)` i `(search_filter_id, created_at desc) where context_type = 'finder'`.
4. Funkcja `enqueue_scheduled_finder_olx_job(filtr, run, url, snapshot, p_shared_limit, p_dry_run) → jsonb`:
   - wyłącznie dla `service_role`;
   - jedyna droga automatycznego zlecenia OLX.

Ostatniego zlecenia nie trzeba zapisywać w osobnej kolumnie. Moment faktycznego zlecenia to
`olx_scan_jobs.created_at`, trwały i ustawiany przez bazę. Późne zakończenie zadania (`finished_at`) niczego nie przesuwa.

### Reguły funkcji (w tej kolejności)

Wszystko odbywa się pod `pg_advisory_xact_lock` (jedna blokada dla wszystkich filtrów i wywołań), według zegara bazy:

| Powód pominięcia | Warunek |
|---|---|
| `FILTER_NOT_FOUND` / `FILTER_INACTIVE` / `OLX_NOT_SELECTED` | filtr nie istnieje, jest wstrzymany albo nie ma OLX |
| `OLX_JOB_IN_FLIGHT` | filtr ma zadanie OLX `queued`/`running` albo wiersz `source_scans` OLX `pending`/`running` (także osierocony) |
| `OLX_INTERVAL_NOT_ELAPSED` | od **zlecenia** ostatniego zadania OLX filtra (dowolnego: automatycznego lub ręcznego) nie minął jego interwał |
| `AUTOMATIC_DAILY_BUDGET_USED` | w ostatnich 24 h jest już 1 automatyczne zadanie OLX Findera (dowolny filtr); limit 1 jest wpisany w funkcję, nie jest parametrem |
| `SHARED_DAILY_BUDGET_USED` | zadania OLX **wszystkich rodzajów** (automatyczne, ręczne, Radar) zlecone lub pobrane przez worker w ostatnich 24 h ≥ `p_shared_limit` |
| `ANOTHER_FILTER_FIRST` | inny aktywny filtr z OLX też jest wymagalny i czeka dłużej (sprawiedliwy podział jednego budżetu) |

- Okno jest kroczące (24 h), a nie dobowe. Zmiana daty o północy niczego nie zeruje.
- Limit 1 na kroczące 24 h oznacza też najwyżej 1 na każdą dobę UTC, czyli na okres resetu limitu Cloudflare.
- Zadanie nieudane lub porzucone **nie zwraca** budżetu. Ponawianie schedulera, w tym ręczny `workflow_dispatch`, niczego nie obejdzie.
- Funkcja nie ponawia zadań i nie zmienia istniejących wierszy.
- `p_dry_run = true` zwraca tylko decyzję (diagnostyka).

### Wspólny budżet (`FINDER_OLX_SHARED_DAILY_JOB_BUDGET`)

Domyślnie **1**: automatyczny OLX ruszy tylko wtedy, gdy w ostatnich 24 h nie było **żadnego** innego zadania
OLX, także ręcznego testu stage2 ani zadania Radaru.
- To celowo ostrożne ustawienie. Odpowiada jedynemu skonfigurowanemu limitowi zadań Cloudflare w projekcie: `OLX_CLOUD_MAX_JOBS_PER_DAY="1"` w `wrangler.stage2.toml`.
- **Skutek:** jeśli Radar cen codziennie zleca zadania OLX, automatyczny OLX Findera będzie pomijany z powodem `SHARED_DAILY_BUDGET_USED`.
- Zwiększenie budżetu to osobna decyzja: zmienna Vercel `FINDER_OLX_SHARED_DAILY_JOB_BUDGET` (1–20, inna wartość → 1). Nie zmienia limitu 1 automatycznego zadania na dobę.

### Limity Cloudflare — zweryfikowane, nie wpisane w kod

Według `cloudflare-docs` (gałąź `production`, `src/content/docs/browser-run/limits.mdx`, odczyt 14.10.2026) plan
Workers Free ma: Browser hours **10 minutes per day**, 3 równoległe przeglądarki, 1 nowa przeglądarka co 20 s
i timeout bezczynności 60 s. Strona developers.cloudflare.com jest z tego środowiska zablokowana (proxy 403),
więc źródłem było repozytorium dokumentacji.

Kod aplikacji **nie zawiera** żadnej liczby sekund przeglądarki na zadanie: nie jest zweryfikowana.
Budżet liczony jest w zadaniach. Czas przeglądarki mierzy wyłącznie worker Cloudflare (ledger w Durable
Object, `GET /status`), dlatego diagnostyka w aplikacji pokazuje go jako „niedostępny”.

## 3. Scheduler (`finder-scheduler.ts`, `finder-olx-schedule.ts`)

Każde wywołanie (pg_cron co 5 min):
1. **Krok OLX** (pierwszy, ograniczony): dla aktywnych filtrów z OLX funkcja SQL decyduje o zleceniu.
   - Najwyżej 1 zlecenie na wywołanie. Powód globalny (budżet, brak funkcji) kończy krok.
   - Timeout 5 s. Każdy błąd, brak migracji, nieczytelny interwał albo nieoczekiwana odpowiedź oznacza **nic nie zlecono**.
   - Logi `FINDER_OLX_SCHEDULE_CHECK_FAILED`. Krok nigdy nie rzuca wyjątku.
2. **Portale** jak dotąd: `finder_scan_interval_minutes`, CAS `claimFinderFilter`, blokada `reserve_source_scans`.
   - Przebieg automatyczny nie zawiera OLX (`olxMode: "separate-schedule"`): nie czyta i nie zapisuje kolejki OLX.
   - W ostrzeżeniach przebiegu jest decyzja OLX, np.
     `olx: OLX_SKIPPED_OLX_INTERVAL_NOT_ELAPSED: nie minął interwał OLX…; następny dopuszczalny termin: …`.
   - Filtr tylko z OLX nie startuje pustego przebiegu portali.

Logi: `FINDER_OLX_SCHEDULER_DECISION` (filtr, decyzja, powód, jobId, runId, ostatnie zlecenie, następny termin,
budżet) oraz `FINDER_SCHEDULER_RUN_COMPLETE.olx` (podsumowanie wywołania). Bez sekretów.

Diagnostyka: `GET /api/flip-finder/search-filters/[id]/olx-schedule` (operator, wyłącznie dry-run, bez możliwości zlecenia lub ponowienia).

## 4. pg_cron: `* * * * *` → `*/5 * * * *`

Skrypty:
- `scripts/finder-cron-every-5-minutes.check.sql`: kontrola przed i po zmianie, tylko `SELECT`, komendy wyłącznie jako `md5`;
- `scripts/finder-cron-every-5-minutes.sql`: zmiana;
- `scripts/finder-cron-every-5-minutes.rollback.sql`: powrót do `* * * * *`.

Weryfikacja skryptu zmiany (test PGlite `finder-cron-every-5-minutes.test.ts`):
- zmienia wyłącznie `schedule` dwóch zadań Findera przez `cron.alter_job`;
- przerywa bez zmian, gdy zadania brakuje, jest zdublowane albo ma inny harmonogram niż `* * * * *` / `*/5 * * * *`;
- porównuje odcisk (`jobid`, nazwa, `md5(command)`, `active`, harmonogramy innych zadań) **wszystkich** zadań cron
  przed i po zmianie. Jakakolwiek inna różnica cofa transakcję;
- jest idempotentny i nie zawiera `cron.schedule`/`unschedule`, sekretów ani Vault.

Zgodność z bazą: skrypt zakłada nazwy i polecenia z `scripts/configure-finder-cron.sql` (`net.http_post` z
nagłówkiem z Vault). Rzeczywisty stan Production potwierdza krok 1 skryptu `check.sql`. Ten PR go nie odczytywał:
nie ma dostępu do bazy.

2880 → 576 wywołań na dobę. Częstotliwość skanów się nie zmienia: test 72 h co 5 minut potwierdza starty portali co
300 min (15 startów) i OLX co 1440 min (3 zadania), 864 wywołania i 864 decyzje OLX, bez ponowień.

## 5. Jeden sterownik harmonogramu (GitHub Actions)

`finder-scan-scheduler.yml` i `finder-scan-continuation.yml` mają już warunek
`github.event_name == 'workflow_dispatch' || vars.FINDER_SCHEDULER_DRIVER != 'supabase-cron'`
(test `finder-cron-configuration.test.ts`). Po potwierdzeniu pg_cron wystarczy ustawić zmienną repozytorium.
Zaplanowane uruchomienia znikną, ręczne `workflow_dispatch` (diagnostyka) zostaje. Zmiana nie wymaga kodu.

## 6. Plan wdrożenia (każdy krok po osobnej zgodzie)

1. **Merge PR → Vercel Production**, sprawdź SHA w `/api/build-info`.
   - Przed migracją kod działa bezpiecznie: zapis filtra pomija brakującą kolumnę, a odczyt daje `null`.
   - Scheduler loguje `OLX_INTERVAL_UNAVAILABLE` i **nie zleca automatycznie OLX**. Portale działają.
   - Ręczne „Skanuj” działa jak dotąd.
   - To zamierzony stan przejściowy: OLX nie jest zlecany co 5 h.
2. **Migracja** `20261014120000_add_finder_olx_schedule.sql`: Supabase → SQL Editor. Kontrola:
   ```sql
   select name, finder_scan_interval_minutes, finder_olx_scan_interval_minutes from public.search_filters;
   select public.enqueue_scheduled_finder_olx_job(id, gen_random_uuid(), 'https://www.olx.pl/', '{}'::jsonb, 1, true)
     from public.search_filters where name = 'Flip';   -- dry run: nic nie zapisuje
   ```
3. **pg_cron:** `check.sql`, potem `finder-cron-every-5-minutes.sql`, potem ponownie `check.sql` (po ~15 min: odstępy 5 min).
4. **GitHub:** po co najmniej kilku godzinach poprawnych przebiegów z pg_cron ustaw `FINDER_SCHEDULER_DRIVER = supabase-cron`
   (Settings → Secrets and variables → Actions → Variables).
5. Obserwacja w logach Vercel: `FINDER_OLX_SCHEDULER_DECISION` (najwyżej 1 `enqueued` na 24 h) i
   `FINDER_SCHEDULER_RUN_RESULT` (portale co 300 min).
   ```sql
   select requested_by, context_type, status, created_at from public.olx_scan_jobs
    where created_at > now() - interval '3 days' order by created_at desc;
   ```

## 7. Rollback

| Element | Wycofanie |
|---|---|
| Kod | Revert commita PR w GitHub i wdrożenie. Stare zachowanie: OLX znów zlecany z cyklem portali. |
| Migracja | `scripts/finder-olx-schedule.rollback.sql` **po** revercie kodu: usuwa funkcję, indeksy i dwie kolumny. Zadania OLX, przebiegi i filtry zostają. Bez revertu kodu scheduler zgłasza `OLX_SCHEDULE_UNAVAILABLE` i po prostu nie zleca OLX. |
| pg_cron | `scripts/finder-cron-every-5-minutes.rollback.sql` (`* * * * *`). |
| GitHub Actions | Usuń zmienną `FINDER_SCHEDULER_DRIVER`. |
| Budżet | Usuń `FINDER_OLX_SHARED_DAILY_JOB_BUDGET` (powrót do 1). |

## 8. Testy

| Plik | Co potwierdza |
|---|---|
| `finder-olx-schedule.rpc.test.ts` (15, PGlite, prawdziwe migracje) | pierwsze zlecenie; brak drugiego przed 24 h mimo zakończenia, także po północy, i dokładnie jedno po 24 h; termin liczony od zlecenia, nie od późnego zakończenia; 48 h; wspólny limit dla filtrów; sprawiedliwość; baza odrzuca < 24 h; zadania ręczne i Radaru zużywają budżet i pozostają niezmienione; nieudane zadanie nie zwalnia budżetu; równoległe wywołania → 1 zadanie; osierocony wiersz OLX; dry-run; uprawnienia; trwałość po restarcie bazy; rollback i ponowne zastosowanie |
| `finder-olx-schedule.test.ts` (7) | prawdziwy scheduler + prawdziwa funkcja SQL: 72 h co 5 min (portale co 300 min, OLX co 1440 min, OLX kończony 12 h później), dwa filtry na jednym koncie, równoczesne wywołania (pg_cron + Actions), awarie (brak funkcji, timeout, błąd, śmieciowa odpowiedź, brak interwału, wyjątek) nie zatrzymują portali, powody globalne, filtr tylko z OLX, raportowanie |
| `manual-scan-lock-separation.test.ts` (+2) | przebieg automatyczny nie czyta i nie zapisuje kolejki OLX; zadanie OLX czekające z wcześniejszego przebiegu go nie blokuje; ścieżka ręczna bez zmian |
| `search-filters-olx-interval.test.ts` (5) | tylko 24/48/72 h; zapis i odczyt kolumny; brak migracji → zapis bez kolumny, odczyt `null`; kilka brakujących kolumn; nieoczekiwana wartość → `null` |
| `olx-schedule/route.test.ts` (3) | 401 bez operatora, 404, wyłącznie dry-run |
| `finder-cron-every-5-minutes.test.ts` (+2) | nieoczekiwany harmonogram przerywa; zmiana komendy wykryta odciskiem i cofnięta; skrypt kontroli tylko czyta |
| `search-filter-form.test.cjs` (+1) | pole „Interwał OLX”, tekst limitu Cloudflare, diagnostyka bez przycisku ponowienia |

Radar cen i Facebook Watcher: brak zmian w ich kodzie, ich testy przechodzą bez zmian. Zadania Radaru są tylko
liczone w budżecie (test PGlite potwierdza, że ich wiersze się nie zmieniają). Filtry tylko z Facebookiem nie
dotykają harmonogramu OLX.
