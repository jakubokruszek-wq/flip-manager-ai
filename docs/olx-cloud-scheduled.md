# OLX bez obsługi: Worker `scheduled` na Cloudflare

> **Aktualizacja (migracja `20261016120000`):** harmonogram w stałych terminach (godzina startu, 12/24/48/72 h,
> Europe/Warsaw), do 2 zadań na 24 h (`max_claims_24h`, domyślnie 1) bramkowanych zmierzonym czasem
> przeglądarki oraz OLX usunięty z Radaru. Zob. [`olx-slot-schedule.md`](olx-slot-schedule.md). Worker ma
> `OLX_CLOUD_MAX_JOBS_PER_DAY = "2"`; budżet bezpieczny bez zmian: 120 s.

Stan: **kod gotowy, nic nie wdrożono i nic nie włączono.**
- Migracja jest szkicem.
- Worker `flip-manager-olx-cloud-scheduled` nie istnieje jeszcze na Cloudflare.
- Przełącznik w bazie powstaje jako **wyłączony**.
- Stage2 zostaje testowym Workerem `manual`, OFF.
- Limity Radaru cen bez zmian.

## 1. Wariant i dlaczego ten

Finder już zleca automatyczne zadania OLX (PR #15):
- interwał 24/48/72 h;
- 1 zadanie na kroczące 24 h dla wszystkich filtrów;
- wspólny budżet z Radarem cen.

Brakowało bezobsługowego **odbioru**. Rozważone warianty:

| Wariant | Ocena |
|---|---|
| Istniejący Worker w trybie `auto` (alarm co 20–40 s, zwykły `/claim`) | **Odrzucony.** Pobiera też Radar i najstarsze zadania, odzyskuje cudze lease, ~2 200 claimów na dobę. |
| Przeniesienie stage2 na produkcję | **Odrzucone.** To Worker testowy (ręczny `jobId`), bez Cron i z testowymi uprawnieniami. |
| GitHub Actions co 24 h | **Odrzucony.** Cel: bez Actions; harmonogram Actions bywa opóźniony o godziny. |
| **Odrębny Worker `scheduled` + osobny claim w bazie** | **Wybrany.** Najmniej zmian, bezobsługowy, każde zabezpieczenie po stronie serwera. |

```
pg_cron co 5 min → Finder scheduler (Vercel)
   ├─ expire_stale_scheduled_finder_olx_jobs()   osierocone → failed + kod, bez usuwania
   └─ enqueue_scheduled_finder_olx_job()         PR #15: interwał, 1/24 h, budżet wspólny z Radarem
                       │ olx_scan_jobs (requested_by = 'scheduler', queued)
Cloudflare Cron */15 → Worker flip-manager-olx-cloud-scheduled (Durable Object, 1 instancja)
   ├─ wyłączony (OLX_CLOUD_ENABLED=0) → usuwa alarm, nic nie robi
   ├─ ledger Workera: 1 zadanie/dobę UTC, 120 s przeglądarki, pauza po odmowie OLX
   ├─ history(): czas przeglądarki CAŁEGO konta dziś; nieznany lub ≥ 120 − 35 s → STOP
   └─ POST /api/olx-worker/claim-scheduled { workerId }  (HMAC)
         └─ claim_scheduled_finder_olx_job()   przełącznik w bazie, brak równoległych, 1/24 h,
                                               tylko automatyczne zadanie Findera, attempts = 0
      → Browser Run (1 sesja) → /heartbeat → /complete albo /fail   (bez zmian)
```

## 2. Kontrola zabezpieczeń (wymaganie: nie przenosić testowego Workera bez kontroli)

| Zabezpieczenie | Gdzie | Test |
|---|---|---|
| Osobny Worker, osobne sekrety i Durable Object; stage2 nietknięty | `wrangler.scheduled.toml`, workflow | `scheduled-config.test.ts` |
| Wdrożony jako wyłączony; Cron przy OFF tylko usuwa alarm | `cron-plan.ts`, `OLX_CLOUD_ENABLED="0"` | `scheduled-mode…` (Cron plan), `scheduled-config…` |
| Tryb `scheduled` odrzuca luźniejsze limity (dzień = 1, trzymane = 1, wywołanie = 1, `leave_queued`, plan ≤ 600 s, budżet ≤ 300 s) | `config.ts` | `scheduled-mode…` |
| Brak ręcznego uruchomienia (`/run-once` → `OLX_CLOUD_SCHEDULED_MODE`) i brak ponowień | `index.ts`, SQL `attempts = 0` | `scheduled-mode…`, `olx-scheduled-claim.rpc…` |
| Tylko automatyczne zadanie Findera; nigdy Radar ani zadanie ręczne; serwer i Worker sprawdzają to oba | SQL + `parseScheduledClaim` + `isScheduledFinderJob` | rpc, `olx-scheduled-claim.test.ts`, `scheduled-mode…` |
| Brak równoległych zadań: żadne zadanie OLX (Finder, Radar, worker lokalny) nie może trzymać żywego lease; jedna blokada; `SKIP LOCKED`; 1 instancja DO | SQL, `cron-plan.ts` | rpc (3 równoległe wywołania → 1), Cron plan |
| Przełącznik STOP w bazie, domyślnie wyłączony | `olx_automation_control` | rpc |
| Brak migracji → 503, nic nie jest odbierane | route + SQL | route, `scheduled-mode…` |
| HMAC + nonce jak w pozostałych endpointach workera; klasyfikacja trasy `SIGNED_WORKER` | route | route, `route-authorization.test.ts` |
| Workflow tylko ręczny, tylko z `main`, włączenie wymaga `WLACZ-AUTOMAT-OLX`, niepotwierdzone włączenie jest od razu cofane | workflow | `scheduled-config…` |

## 3. Limity — co i gdzie jest liczone

Źródło: `cloudflare-docs` (`browser-run/limits.mdx`, `pricing.mdx`, `playwright/index.mdx`, odczyt 14.10.2026).
Plan Free: **10 min przeglądarki na dobę dla całego konta**, 3 równoległe przeglądarki, 1 nowa co 20 s, 429 po
przekroczeniu. `history()` zwraca ostatnie sesje (start i koniec).

| Limit | Mechanizm |
|---|---|
| Kalendarz OLX (24/48/72 h, 1 na 24 h dla wszystkich filtrów) | PR #15 przy zleceniu; dodatkowo `max_claims_24h = 1` przy odbiorze |
| Wspólny budżet z Radarem cen (`FINDER_OLX_SHARED_DAILY_JOB_BUDGET`, domyślnie 1) | PR #15 przy zleceniu (bez zmian); przy odbiorze: brak równoległej pracy z zadaniem Radaru |
| Dzienny czas przeglądarki **Workera** | ledger DO: bezpieczny budżet 120 s z 600 s, rezerwa 35 s przed stroną |
| Dzienny czas przeglądarki **konta** (stage2, inne Workery, ewentualnie Radar na Cloudflare) | `history()` przed każdym claimem: `max(konto, ledger) + 35 s > 120 s` → `OLX_CLOUD_ACCOUNT_BUDGET_EXHAUSTED`; brak odczytu → `OLX_CLOUD_ACCOUNT_USAGE_UNKNOWN` (nic nie startuje) |
| 429 Cloudflare | pauza do północy UTC (bez zmian) |
| Odmowa OLX (403/405/429/weryfikacja) | już po 1 odmowie pauza 24 h; zabezpieczeń OLX się nie obchodzi |

`history()` nie gwarantuje pełnej listy sesji. Liczony jest więc większy z dwóch odczytów (konto albo ledger),
a niepewność oznacza brak startu.

## 4. Zadania błędne i osierocone (bez usuwania historii)

| Sytuacja | Diagnoza |
|---|---|
| Zadanie automatyczne nieodebrane przez 6 h (Worker OFF, STOP, awaria) | `failed`, `OLX_SCHEDULED_JOB_NOT_CLAIMED`, także jego `source_scans`; scheduler (co 5 min) |
| Lease zadania automatycznego martwe > 10 min | `failed`, `OLX_SCHEDULED_JOB_LEASE_EXPIRED` |
| 90-sekundowy watchdog podglądu skanu | **nie dotyczy** zadań automatycznych (czekają na Cron do 15 min); zadania ręczne bez zmian |
| Błąd strony, odmowa, budżet | `/fail` z kodem (bez zmian); `attempts > 0` → nigdy ponownie |

Nic nie jest usuwane. Kolejne zadanie zleca kalendarz (PR #15), liczony od zlecenia poprzedniego.

## 5. Raport zużycia zasobów (stan docelowy, automat włączony)

| Zasób | Na dobę | Limit Free | Uwagi |
|---|---|---|---|
| Wywołania Workera (Cron) | 96 | 100 000 | `*/15` |
| Żądania Durable Object (tick + alarm) | ~192 | 100 000 | |
| Zapisy DO (diagnostyka + ledger) | ~100–150 | 100 000 | ledger zapisywany tylko przy zmianie |
| CPU na tick | < 1 ms | 10 ms | zadanie ~3–5 ms (pomiar z etapu 1/2) |
| Subrequesty na tick / na zadanie | 2 / ~10 | 50 | `history()` + claim; zadanie: limits, sesja, ~3 heartbeat, complete, history |
| Browser Run | ≤ 1 sesja, ≤ 120 s | 600 s (konto) | ≤ 20% planu; rzeczywisty czas: `/status → browserSecondsUsedToday` i `chargedMs` w `recent` |
| Wywołania Vercel `claim-scheduled` | 96 (+ ~5 na zadanie) | Hobby: 1 mln/mies. | ~3 000/mies. (0,3%) |
| RPC Supabase | 96 claim + 288 expire + 288 decyzji | brak limitu zapytań na Free | expire/decyzje w tym samym wywołaniu schedulera pg_cron |
| GitHub Actions | 0 | — | workflow tylko ręczny (wdrożenie, kontrola, STOP) |

Dla porównania odrzucony tryb `auto`: ~2 200 claimów na dobę (~66 tys./mies.), zadania Radaru i odzysk cudzych lease.

## 6. Monitoring

- **Aplikacja:** pole „Interwał OLX” w ustawieniach filtra → „Automatyczne pobieranie (Cloudflare)”: WŁĄCZONE albo WYŁĄCZONE (STOP), ostatnie zadanie, status, kod i worker.
- **Logi Vercel:** `FINDER_OLX_SCHEDULER_DECISION`, `FINDER_OLX_SCHEDULED_JOBS_EXPIRED`, `FINDER_OLX_EXPIRE_FAILED`.
- **Worker:** `GET /status` (Bearer) pokazuje:
  - `lastWork.outcome` / `claimReason` (`NO_DUE_JOB`, `AUTOMATION_DISABLED`, `DAILY_CLAIM_USED`, `OLX_JOB_RUNNING`), `accountBrowserMs`;
  - `paused`, `ledger`, `lastCron`, `recent`.

  Workers Logs: `CRON_TICK_SCHEDULED_CLAIM`, `OLX_CLOUD_PAUSED`, `JOB_*`.
- **SQL:** `scripts/olx-cloud-scheduled.check.sql` (tylko odczyt): przełącznik, ostatnie zadania z czasem oczekiwania i pracy, budżet 24 h, równoległe i osierocone, kody błędów.
- **Workflow:** akcja `check` daje podsumowanie `/status` bez sekretów i jeden self-test HMAC (nic nie pobiera).

## 7. Plan wdrożenia (każdy krok po osobnej zgodzie; **nie dziś** — dziś nie uruchamiamy skanu)

1. **Merge PR → Vercel.** Bez migracji nic się nie zmienia:
   - `claim-scheduled` odpowiada 503;
   - wygaszanie jest no-op;
   - watchdog ręcznych zadań działa jak dotąd.
2. **Migracja** `20261015120000_add_scheduled_olx_claim.sql`. Przełącznik zostaje **false**. Kontrola: `check.sql` (krok 1).
3. **GitHub:** utwórz środowisko `olx-cloudflare-scheduled` (zalecane: wymagany recenzent) i sekrety `CLOUDFLARE_API_TOKEN_SCHEDULED`, `OLX_CLOUD_ADMIN_TOKEN_SCHEDULED`, `OLX_WORKER_SECRET_SCHEDULED`.
4. **Workflow `deploy-disabled`**, potem `check`. Oczekiwane: tryb `scheduled`, OFF, Worker i DO na jednej wersji, HMAC 409.
5. **Weryfikacja budżetu przed włączeniem:**
   - z podsumowania stage2 z 14.10 (`browserSecondsUsedToday`, `chargedMs`) potwierdź, że 1 zadanie mieści się w 120 s;
   - `check.sql` (krok 3): ile zadań Radaru OLX dziennie. Przy codziennym Radarze z OLX wspólny budżet 1 będzie blokował Findera (`SHARED_DAILY_BUDGET_USED`); to decyzja o budżecie, ten PR jej nie zmienia.
6. **Włączenie** (inny dzień niż test):
   1. `enable.sql` w bazie;
   2. workflow `enable` z `WLACZ-AUTOMAT-OLX`.

   Pierwsze zadanie zostanie odebrane najpóźniej 15 min po zleceniu przez kalendarz Findera.
7. **Kontrola po pierwszym zadaniu:** `check.sql` (krok 2: `completed`, `waited_for_claim` ≤ 15 min, `fetched`), `/status` (`browserSecondsUsedToday` ≤ 120, `paused = null`). Przez 3 doby sprawdzaj codziennie, potem co tydzień.

## 8. STOP i rollback

| Poziom | Działanie | Czas |
|---|---|---|
| STOP w bazie | `scripts/olx-cloud-scheduled.stop.sql` → każdy claim `AUTOMATION_DISABLED` | natychmiast, bez wdrożenia |
| STOP Workera | workflow `disable` (wdrożenie z `OLX_CLOUD_ENABLED=0`, potwierdzone `/status`) | ~1–2 min |
| Wycofanie kodu | revert PR (Vercel); Worker zostaje OFF | wdrożenie |
| Wycofanie migracji | najpierw STOP, potem `scripts/olx-cloud-scheduled.rollback.sql` (usuwa 2 funkcje i tabelę przełącznika; zadania i historia zostają) | ręcznie |
| Usunięcie Workera | Cloudflare → Workers → `flip-manager-olx-cloud-scheduled` → Delete (po STOP) | ręcznie |

Trwające zadanie (najwyżej 1, ≤ ~4 min) po STOP kończy się normalnie. Portale Findera, Radar i ręczne skany nie są
dotknięte żadnym z tych kroków.

## 9. Testy

| Plik | Liczba | Co potwierdza |
|---|---|---|
| `features/flip-finder/server/olx-scheduled-claim.rpc.test.ts` (PGlite, prawdziwe migracje) | 8 | wyłączony domyślnie; tylko zadanie automatyczne (ręczne i Radar nietknięte); lease i `source_scans`; 1/24 h; 3 równoległe → 1; zadanie trwające (dowolne) blokuje; brak odzysku cudzych lease; brak ponowień; filtr wstrzymany lub bez OLX; wygaszanie bez usuwania (zadania ręczne nietknięte); STOP; ograniczenia tabeli; uprawnienia; rollback i ponowne zastosowanie |
| `features/flip-finder/server/olx-scheduled-claim.test.ts` | 5 | payload `{ workerId }`, mapowanie, odrzucanie niespójnych odpowiedzi, wygaszanie, monitoring |
| `app/api/olx-worker/claim-scheduled/route.test.ts` | 3 | HMAC, powód, selektor odrzucony, 503 bez migracji |
| `scan-progress-olx-watchdog.test.ts` | +1 | zadanie automatyczne nie ginie po 90 s, ręczne tak |
| `finder-olx-schedule.test.ts` | +1 | wygaszanie przed decyzją, błąd wygaszania nie blokuje portali |
| `workers/olx-cloudflare/test/scheduled-mode.integration.test.ts` (prawdziwy HMAC, kolejka testowa, lokalny Chromium) | 12 | pełny przebieg 1 zadania; nigdy `/claim`; dzienny limit Workera; STOP w bazie; budżet konta z `history()` przekroczony lub nieznany → brak żądań; ledger; pauza 24 h po odmowie bez claimu „do odrzucenia”; 503; trwające zadanie Radaru; obrona przed zadaniem Radaru; odrzucanie luźnych limitów; plan Cron; liczenie `history()`; model zasobów |
| `workers/olx-cloudflare/test/scheduled-config.test.ts` | 5 | osobny Worker, OFF, limity, wiązania jak w głównym, workflow |
| `workers/olx-cloudflare/test/scheduled-status-script.test.ts` | 2 | potwierdzanie stanów i odrzucanie luźniejszej konfiguracji |
