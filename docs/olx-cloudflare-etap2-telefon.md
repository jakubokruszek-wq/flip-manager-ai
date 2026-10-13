# Etap 2 OLX Cloudflare z telefonu — jedno zadanie Findera

Workflow `.github/workflows/olx-cloudflare-stage2.yml` (tylko ręcznie, `workflow_dispatch`) obsługuje
wyłącznie osobny Worker testowy **`flip-manager-olx-cloud-stage2`** (`workers/olx-cloudflare/wrangler.stage2.toml`).
Nie zmienia `flip-manager-olx-cloud`, `flip-manager-olx-cloud-stage1`, Vercel ani Supabase.

| Akcja | Co robi |
|---|---|
| `deploy-disabled` | kontrola konfiguracji i dry-run → wdrożenie Workera **wyłączonego** (`ENABLED=0`, `manual`, bez Cron) → sekrety Workera → weryfikacja `/status` |
| `check` | `/status` (musi być wyłączony) + **jedno** `POST /selftest?selective=1`: podpisany heartbeat losowego ID (oczekiwane 409) i próba `claim-selective` z losowym ID (oczekiwane `{ job: null }`) |
| `run-one-job` | wymaga `job_id` (UUID) i `confirm = URUCHOM-1-ZADANIE`; kontrola jak w `check` + limit dzienny niewykorzystany → włączenie tylko na ten przebieg → **jedno** `POST /run-once?jobId=…` bez ponawiania → **zawsze** ponowne wdrożenie wyłączonego Workera (także po błędzie lub anulowaniu) → podsumowanie |
| `enable-probe` | diagnostyka: kontrola stanu wyłączonego → włączenie tylko na ten przebieg → potwierdzenie stanu włączonego → **zawsze** ponowne wyłączenie i jego potwierdzenie. **Bez** `/run-once`, bez `/selftest`, bez pobierania zadań |
| `disable` | awaryjne ponowne wdrożenie wyłączonego Workera |

Zwykłe `/claim` i selektor filtra **nie są używane**. Worker odrzuca każdy parametr inny niż `jobId`.

## Kontrola wersji (poprawka po przebiegu 38455654010)

Przebieg 38455654010: `wrangler deploy --var OLX_CLOUD_ENABLED:1` się powiódł, ale 12 kontroli `/status`
nie potwierdziło włączenia, więc `/run-once` pominięto. Worker został wyłączony, a zadania pozostały
`queued` z `attempts = 0`.

- `--var` działa poprawnie. Wrangler 4.143 wysyła zmienną jako zwykły tekst `"1"`, a w logu tylko ukrywa
  wartość (`"(hidden)"`).
- Wyłącznik czyta Durable Object ze **swojego** środowiska. Gdy instancja DO jest stale budzona
  (odpytywanie co 5 s), może jeszcze chwilę działać na poprzedniej, wyłączonej wersji. Najbardziej
  prawdopodobne jest właśnie to: wyłączenie po teście potwierdziło się już przy pierwszej próbie, czyli
  DO wciąż miał wyłączone środowisko. Stary workflow nie wypisywał treści `/status`, dlatego nie da się
  tego udowodnić wprost. Nowa diagnostyka to rozstrzygnie.

Poprawka:
- `/status` ma blok `version`: `worker` (wersja wdrożona), `runner` (wersja Durable Object), `matches`,
  `runnerReset`. Wartości pochodzą z wiązania `CF_VERSION_METADATA`.
- Przed każdym żądaniem administracyjnym Worker przekazuje DO swoją wersję. Bezczynny DO na innej wersji
  resetuje się sam (`ctx.abort`), a następne wywołanie trafia do świeżej instancji. Trwające zadanie nie
  jest nigdy przerywane.
- `/run-once` i `/selftest` odmawiają (`OLX_CLOUD_RUNNER_VERSION_MISMATCH`), gdy wersja DO jest inna niż
  wersja Workera.
- Workflow odczytuje `Current Version ID` z każdego wdrożenia. Uznaje stan za potwierdzony dopiero wtedy,
  gdy **i Worker, i DO** działają na tej wersji (24 próby co 5 s). Każda próba wypisuje: HTTP, `ok`,
  `code`, `killSwitch`, tryb, limity, `running`, `nextAlarm` i wersje. Sekretów w logu nie ma: `/status`
  pokazuje je wyłącznie jako `set`/`missing`.
- Kontrole są w `workers/olx-cloudflare/scripts/stage2-status.sh` i mają testy regresyjne.

**Po scaleniu tej poprawki** zacznij od `deploy-disabled`. Stara wersja Workera nie ma bloku `version`,
więc `check` odmówi do czasu ponownego wdrożenia.

## Bezpieczeństwo ponownego uruchomienia

- Drugie `run-one-job` tego samego dnia (UTC) zatrzymuje się przed włączeniem: `MAX_JOBS_PER_DAY=1`
  jest wykorzystany. Worker sam też odmawia (pauza `OLX_CLOUD_DAILY_JOB_CAP_REACHED`, zero żądań).
- Zadanie już ukończone lub nieudane nie jest `queued`, więc `claim-selective` zwraca `{ job: null }`.
- Workflow ma `concurrency` — dwa przebiegi nie działają równocześnie.
- `check` niczego nie zmienia; jedyny zapis po stronie aplikacji to jednorazowy nonce HMAC (5 min).

## Wymagane sekrety GitHub

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
(albo w środowisku `olx-cloudflare-stage2`, patrz niżej):

| Sekret | Wartość |
|---|---|
| `CLOUDFLARE_API_TOKEN_STAGE2` | token API Cloudflare z uprawnieniem **Workers Scripts: Edit** dla tego konta (można użyć tego samego co w etapie 1, jeśli ma to uprawnienie) |
| `CLOUDFLARE_ACCOUNT_ID` | już istnieje (32 znaki hex) |
| `OLX_CLOUD_ADMIN_TOKEN_STAGE2` | **nowy** losowy token ≥ 32 znaki (np. menedżer haseł → 48 znaków), tylko dla Workera stage2 |
| `OLX_WORKER_SECRET_STAGE2` | **ta sama** wartość co `OLX_WORKER_SECRET` w Vercel (po niedawnej wymianie). Nie generuj nowej |

Sekrety trafiają do Workera przez `wrangler secret put` ze standardowego wejścia; nie są wypisywane
w logach ani zapisywane w plikach.

Zalecane: **Settings** → **Environments** → **New environment** `olx-cloudflare-stage2` → **Required
reviewers**: Ty. Wtedy każdy przebieg czeka na Twoje zatwierdzenie (*Review deployments* → *Approve*).
Jeśli środowiska nie utworzysz, GitHub utworzy je automatycznie bez reguł.

## Wybór zadania (Supabase → SQL Editor, tylko odczyt)

```sql
select id, scan_run_id, search_filter_id, status, attempts, max_attempts,
       available_at, created_at, request_url
  from public.olx_scan_jobs
 where context_type = 'finder' and status = 'queued'
   and attempts < max_attempts and available_at <= now()
 order by created_at desc;
```

Wybierz jedno zadanie (najlepiej najnowsze, `attempts = 0`) i skopiuj jego `id`.
**Nie otwieraj w Finderze postępu tego skanu przed testem**: watchdog Findera (`expireUnclaimedOlxJobs`)
oznacza jako nieudane zadania `queued` starsze niż 90 s, ale tylko podczas odpytywania postępu danego skanu.
Zadania Radaru (`context_type = 'price_radar'`) są nietykalne — funkcja SQL ich nie pobierze.

## Kolejność z telefonu (każdy krok to osobna zgoda)

1. **Migracja Supabase** `20261013180000_add_selective_olx_claim.sql` (PR backendu) — SQL Editor →
   wklej treść pliku → **Run**. Tworzy tylko nową funkcję.
2. **Merge PR backendu** → Vercel wdroży Production z `/api/olx-worker/claim-selective`. Poczekaj na **Ready**.
3. **Merge PR Workera** (ten workflow działa tylko z `main`).
4. Dodaj sekrety (tabela wyżej).
5. **Actions** → **OLX Cloudflare — etap 2 …** → **Run workflow** → `action = deploy-disabled`.
   Summary: „Worker WYŁĄCZONY”.
6. `action = enable-probe` (opcjonalnie, zalecane po tej poprawce). Summary: „Włączenie: POTWIERDZONE”
   i „Worker po próbie: WYŁĄCZONY”. Nic nie jest pobierane.
7. `action = check`. Summary: HMAC ok (409), claim-selective dostępny. Błąd 503 (brak funkcji SQL) albo 404
   (brak endpointu) oznacza, że krok 1 lub 2 nie został wykonany.
8. Odczytaj `id` zadania (SQL wyżej).
9. `action = run-one-job`, `job_id = <id>`, `confirm = URUCHOM-1-ZADANIE`.
10. Summary: `claimed 1`, `completed 1`, czas przeglądarki (spodziewane ~10–40 s), zdarzenia, „Worker po
   teście: WYŁĄCZONY ✅”. Uruchom podane zapytania SQL (tylko odczyt) i sprawdź oferty w Finderze.
11. Jeśli cokolwiek wygląda źle: `action = disable`.

## Koszt (Cloudflare Workers Free)

0 zł. Bez Cron i alarmów; na test: kilka żądań Workera, ~10 podzapytań, 1 sesja przeglądarki
(limit dzienny 120 s z 600 s), 1 Durable Object (SQLite, Free). Wdrożenia z GitHub Actions mieszczą się
w darmowych minutach GitHub Actions (przebieg ~2–4 min).

## Wycofanie

- `action = disable` (Worker wyłączony, kod bez zmian).
- Całkowite usunięcie: Cloudflare → **Workers & Pages** → `flip-manager-olx-cloud-stage2` → **Settings** →
  **Delete**. Pozostałe Workery nie są dotknięte.
- Funkcja SQL może zostać (nieużywana) albo: `drop function public.claim_olx_scan_job_selective(text, uuid, integer);`
- Oferty zapisane przez test to zwykłe oferty Findera z tego skanu (te same ścieżki co worker lokalny).
