# OLX worker na Cloudflare Workers Free + Browser Run

Wariant podstawowy workera OLX: bez komputera i bez płatnego hostingu (0 zł/mies.).
Kod jest w `workers/olx-cloudflare/`. Lokalny worker Windows (`workers/olx-browser`) i wariant Railway
(PR #3) pozostają bez zmian jako warianty awaryjne. Railway nie jest wdrażany.

> Status: **nie wdrożono**. Ten dokument opisuje konfigurację i wdrożenie. Każdy krok,
> który dotyka konta Cloudflare albo produkcyjnej kolejki, wymaga zatwierdzenia.

## 1. Jak to działa

```
Finder / Radar (Vercel)                       Cloudflare (Free)
──────────────────────                        ──────────────────────────────────────────────
enqueue → olx_scan_jobs (Supabase)            Cron Trigger (co 1 min, tylko siatka bezpieczeństwa)
                │                                   │ re-arm, jeśli alarm zginął
                │   HTTPS + HMAC                    ▼
   /api/olx-worker/claim  ◄──────────────  Durable Object "olx-runner" (jedna instancja)
   /api/olx-worker/heartbeat ◄───────────     alarm co 20 s bez zadań, ~1 s po pracy
   /api/olx-worker/complete  ◄───────────     │ budżet przeglądarki (ledger w SQLite DO)
   /api/olx-worker/fail      ◄───────────     ▼
                                           Browser Run (@cloudflare/playwright)
                                              jedna sesja na partię zadań, świeży context na zadanie
                                              w stronie: ekstrakcja PRERENDERED_STATE
                                                         + parser Findera (bundle) + weryfikacja
```

- **Kolejka**: bez zmian. Worker używa tych samych endpointów `/api/olx-worker/*` co worker lokalny:
  HMAC (`x-olx-worker-*`), nonce, lease 120 s, heartbeat co 30 s, `complete`/`fail` związane z `leaseToken`
  (dla Radaru także z `radarLeaseToken`). Logika zadania to współdzielony `runOlxJob`
  z `workers/olx-browser/src/job-runner.ts`, importowany bez modyfikacji.
- **Brak drugiej bazy**: worker nie zapisuje ogłoszeń. W Durable Object trzyma tylko licznik
  budżetu i diagnostykę.
- **Harmonogram**: polling napędza alarm Durable Object, a nie Cron. Cron (min. 1 min) tylko przywraca
  alarm, gdyby zginął. Finder oznacza zadanie jako `OLX_WORKER_CLAIM_TIMEOUT`, jeśli nikt go nie
  odbierze w 90 s:
  - normalnie: odbiór ≤ 20 s + opóźnienie alarmu (symulacja z opóźnieniami do 15 s: najgorzej ~32 s);
  - utracony alarm: kolejny Cron go przywraca (symulacja z opóźnieniem crona do 25 s: najgorzej ~41 s,
    teoretycznie ≤ ~86 s);
  - kilka zadań naraz (skan wielu filtrów): odbierane po 2 na wywołanie, kolejne ~1 s później.
    Odebrane zadanie ma lease, więc nie podlega już 90-sekundowemu limitowi.
- **Parsowanie**: `window.__PRERENDERED_STATE__` jest czytany z oryginalnego skryptu inline.
  Parser Findera (`features/flip-finder/olx-parser.ts`) jest zbundlowany (`scripts/build-in-page-bundle.mjs`)
  i wykonywany **w przeglądarce**, bo normalizacja 40 ofert to ~8–12 ms CPU, a Workers Free daje
  ~10 ms na wywołanie. Worker przesyła gotowy JSON do `/complete` bez parsowania (~3 ms CPU na zadanie:
  odpowiedź CDP + podpis HMAC).
- **Weryfikacja wyniku** (ostrzeżenia trafiają do skanu w Finderze):
  - liczba ofert w stanie vs liczba kart `[data-cy="l-card"]` (`OLX_CLOUD_COUNT_MISMATCH`);
  - odrzucone przy normalizacji (`OLX_CLOUD_NORMALIZATION_DROPPED`);
  - duplikaty ID;
  - pusta lista mimo `totalElements > 0` (`OLX_CLOUD_EMPTY_DESPITE_TOTAL`);
  - pokrycie pól: cena, metraż, URL < 90%; brak w całości pokoi, dzielnicy, daty publikacji
    lub typu budynku (`OLX_CLOUD_FIELD_COVERAGE`).
  Pełne pokrycie pól jest w logu `OLX_PAGE_VERIFIED`.
- **Zabezpieczenia OLX**: HTTP 403/405/429 → `OLX_HTTP_<kod>`, strona weryfikacji/CAPTCHA →
  `OLX_HUMAN_VERIFICATION`. Zadanie kończy się błędem i nie jest ponawiane. Nic nie jest obchodzone:
  nie ma rotacji IP, solverów, fałszowania fingerprintu ani cookies użytkownika. Domyślnie skrypty
  strony OLX są wyłączone (`OLX_CLOUD_PAGE_JAVASCRIPT=0`), bo dane są w HTML renderowanym
  po stronie serwera. To skraca czas przeglądarki, a challenge i tak jest wykrywany.

## 2. Limity Cloudflare Free i jak są pilnowane

| Limit (Workers Free, stan z dokumentacji, 10.2026) | Jak worker go respektuje |
|---|---|
| Browser Run: **10 min/dzień** (UTC), potem HTTP 429 | Własny licznik w DO: stop przy **480 s** (`OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS`). Strona otwierana tylko, jeśli zostaje ≥ 35 s rezerwy. Czas sesji liczony od acquire do close, a gdy Cloudflare (`history()`) podaje więcej, przyjmowana jest większa wartość. Osierocona sesja liczona jest w najgorszym wariancie. 429 od Cloudflare → pauza do północy UTC. |
| Browser Run: 1 nowa przeglądarka / 20 s, 3 równoległe | Jedna sesja na partię zadań. Przed `launch` wywoływane jest `limits()`, a w razie potrzeby worker czeka. |
| Browser Run: timeout 60 s | Sesja zamykana po ≤ 45 s, `keep_alive` 20 s, `goto` ≤ 30 s. |
| CPU: **10 ms / wywołanie** (z niewielką tolerancją) | Parser w przeglądarce, surowy `complete`, ≤ 2 zadania na wywołanie (`OLX_CLOUD_MAX_JOBS_PER_INVOCATION`). |
| 50 subrequestów / wywołanie | Licznik w runnerze (limit roboczy 45), rezerwa na każde zadanie i sesję. |
| 100 tys. żądań/dzień, DO: 100 tys. zapisów wierszy/dzień | Alarm co 20 s ≈ 4,3 tys. wywołań + 1,4 tys. cronów dziennie. Ledger zapisywany tylko przy zmianie. |
| Cron Triggers: 5 na konto | Używany 1. |
| Rozmiar Workera 3 MB (gzip) | ~650 KB gzip. |

Po wyczerpaniu budżetu (`OLX_CLOUD_ON_BUDGET_EXHAUSTED`):
- `fail_jobs` (domyślnie): każde nowe zadanie jest odbierane i od razu zamykane kodem
  `OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED` z komunikatem, np. *„Cloudflare Browser Run: osiągnięto bezpieczny
  dzienny budżet przeglądarki (zużyto 482 s z 480 s; limit planu 600 s). Pobieranie OLX wstrzymane do
  2026-10-14T00:00:00.000Z.”* Finder pokazuje ten komunikat zamiast ogólnego „worker nie odebrał zadania”.
- `leave_queued`: zadania zostają w kolejce dla workera awaryjnego (Windows/Railway). Bez niego Finder
  po 90 s oznaczy je `OLX_WORKER_CLAIM_TIMEOUT`.

## 3. Wymagania

- Konto Cloudflare (Workers Free) z Browser Run. Istnieje testowy Worker `flip-manager-olx-cloud`,
  a ta konfiguracja go **zastąpi** (ta sama nazwa).
- Node 22+, `npm`.
- Adres produkcyjny aplikacji (Vercel) i **ten sam** `OLX_WORKER_SECRET` co w Vercel (≥ 32 znaki).

## 4. Konfiguracja i wdrożenie (Wrangler)

Wszystkie polecenia uruchamiaj w `workers/olx-cloudflare/`.

```bash
cd workers/olx-cloudflare
npm ci
npm test                 # 38 testów, w tym lokalny Chromium (pominięte, jeśli go brak)
npm run typecheck
npm run build:check      # wrangler deploy --dry-run: bundel bez wysyłania
```

Logowanie i sekrety (nic nie trafia do repozytorium):

```bash
npx wrangler login
npx wrangler whoami                          # sprawdź, że to właściwe konto
npx wrangler secret put OLX_WORKER_SECRET    # ten sam co w Vercel
npx wrangler secret put OLX_CLOUD_ADMIN_TOKEN   # losowy ≥ 32 znaki, np. openssl rand -hex 32
```

Ustaw w `wrangler.toml` (sekcja `[vars]`) adres aplikacji:

```toml
OLX_WORKER_API_URL = "https://<adres-produkcyjny-aplikacji>"
```

Pierwsze wdrożenie z **wyłączonym** odbiorem zadań (`OLX_CLOUD_ENABLED = "0"`, jak w repozytorium):

```bash
npx wrangler deploy
curl https://flip-manager-olx-cloud.<subdomena>.workers.dev/health
curl -H "authorization: Bearer $OLX_CLOUD_ADMIN_TOKEN" https://flip-manager-olx-cloud.<subdomena>.workers.dev/status
```

`/status` powinien zwrócić `ok: false, code: "OLX_CLOUD_DISABLED"`. Od tej chwili Cron działa, ale niczego nie odbiera.

Zmienne (`[vars]`, wartości domyślne):

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `OLX_CLOUD_ENABLED` | `0` | Wyłącznik. `1` = odbieranie zadań. |
| `OLX_WORKER_API_URL` | — | HTTPS aplikacji. |
| `OLX_CLOUD_WORKER_ID` | `cloudflare-olx-1` | `worker_id` w `olx_scan_jobs`. |
| `OLX_CLOUD_IDLE_POLL_SECONDS` | `20` | Odstęp claim bez zadań (10–45 s). |
| `OLX_CLOUD_DAILY_BROWSER_LIMIT_SECONDS` | `600` | Limit planu (Free: 600). |
| `OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS` | `480` | Własny próg zatrzymania. |
| `OLX_CLOUD_SCRAPE_RESERVE_SECONDS` | `35` | Rezerwa wymagana przed otwarciem strony. |
| `OLX_CLOUD_SESSION_MAX_SECONDS` | `45` | Maks. wiek sesji przeglądarki. |
| `OLX_CLOUD_KEEP_ALIVE_SECONDS` | `20` | `keep_alive` Browser Run. |
| `OLX_CLOUD_MAX_JOBS_PER_DAY` | `0` | Dzienny limit zadań (0 = brak), do testu. |
| `OLX_CLOUD_MAX_HELD_JOBS` | `2` | Zadania trzymane równocześnie. |
| `OLX_CLOUD_MAX_JOBS_PER_INVOCATION` | `2` | Zadania na jedno wywołanie (limit CPU). |
| `OLX_CLOUD_ON_BUDGET_EXHAUSTED` | `fail_jobs` | `fail_jobs` / `leave_queued`. |
| `OLX_CLOUD_BLOCK_HEAVY_RESOURCES` | `1` | Blokuj obrazy, fonty, media i trackery (CDP). |
| `OLX_CLOUD_PAGE_JAVASCRIPT` | `0` | `1` = uruchamiaj skrypty strony OLX. |
| `OLX_CLOUD_RESTRICT_TO_OLX_DOMAINS` | `0` | `1` = guardrail Browser Run tylko na `olx.pl`. |

Sekrety: `OLX_WORKER_SECRET`, `OLX_CLOUD_ADMIN_TOKEN`.

## 5. Proponowany ograniczony test produkcyjny (do zatwierdzenia)

Cel: potwierdzić na prawdziwym Cloudflare trzy rzeczy, których nie da się sprawdzić lokalnie:
czas CPU wywołania, czas przeglądarki na stronę i akceptację OLX dla Browser Run z wyłączonym JS strony.

1. **Przygotowanie (bez zadań)**: wdrożenie jak w p. 4, `OLX_CLOUD_ENABLED=0`.
2. **Włączenie z twardymi limitami**: w `[vars]` ustaw
   `OLX_CLOUD_ENABLED="1"`, `OLX_CLOUD_MAX_JOBS_PER_DAY="2"`, `OLX_CLOUD_MAX_JOBS_PER_INVOCATION="1"`,
   `OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS="120"`, `OLX_CLOUD_ON_BUDGET_EXHAUSTED="leave_queued"`.
   Potem `npx wrangler deploy`. Lokalny worker Windows może zostać włączony: kolejka używa
   `FOR UPDATE SKIP LOCKED`, więc zadanie dostanie dokładnie jeden worker.
3. **Jedno zadanie**: w Finderze uruchom ręcznie skan **jednego** filtra OLX (Łódź). W osobnym terminalu
   uruchom `npx wrangler tail --format pretty` i obserwuj zdarzenia `JOB_START`, `OLX_PAGE_VERIFIED`,
   `JOB_COMPLETE` i `BROWSER_SESSION_CLOSED`.
4. **Sprawdź**:
   - w Finderze: liczba ofert = `rawItems` z logu, poprawne ceny/metraże/dzielnice/daty, brak ostrzeżeń
     `OLX_CLOUD_*` albo ich zrozumiała treść;
   - `/status`: `browserSecondsUsedToday` (oczekiwane kilka sekund na stronę), `lastWork`, brak `lastError`;
   - Dashboard → Workers → `flip-manager-olx-cloud` → Observability: **CPU time** wywołań alarmu
     (oczekiwane < 10 ms) i brak wyników `exceededCpu`;
   - porównaj wynik z ostatnim skanem tego filtra z workera lokalnego.
5. **Decyzja**: przy pozytywnym wyniku ustaw domyślne wartości z tabeli (budżet 480 s, `fail_jobs`
   albo `leave_queued`, jeśli zostaje worker awaryjny, `MAX_JOBS_PER_DAY=0`) i wdróż ponownie.
   Automatycznych skanów Production nie uruchamiaj bez osobnej zgody.

Wycofanie w dowolnym momencie: `OLX_CLOUD_ENABLED="0"` + `npx wrangler deploy`, albo usunięcie Workera
w panelu. Kolejka i dane w Supabase nie są w żaden sposób zmieniane.

Ręczne pobranie jednego zadania (bez czekania na alarm):

```bash
curl -X POST -H "authorization: Bearer $OLX_CLOUD_ADMIN_TOKEN" "https://flip-manager-olx-cloud.<subdomena>.workers.dev/run-once?maxJobs=1"
```

## 6. Diagnostyka

`GET /status` (Bearer `OLX_CLOUD_ADMIN_TOKEN`) zwraca:
- `ledger` — zużycie dnia: `browserMs`, `sessions`, `jobsClaimed`, `jobsCompleted`, `jobsFailed`, `jobsRejected`;
- `paused` — aktywna pauza z kodem i godziną wznowienia;
- `nextAlarm`, `lastCron` (z opóźnieniem crona), `lastWork`, `lastError`, `recent` (ostatnie 40 zdarzeń).

Bez tokenu oba endpointy zwracają 404. Publiczny jest tylko `/health`.

| Kod w `olx_scan_jobs.error_code` | Znaczenie |
|---|---|
| `OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED` | Wyczerpany bezpieczny budżet dnia; wznowienie o północy UTC. |
| `OLX_CLOUD_BROWSER_DAILY_LIMIT_429` | Cloudflare odrzucił sesję (limit planu); pauza do północy UTC. |
| `OLX_CLOUD_DAILY_JOB_CAP_REACHED` | Osiągnięty `OLX_CLOUD_MAX_JOBS_PER_DAY`. |
| `OLX_CLOUD_BROWSER_RATE_LIMITED` | Limit nowych sesji (1/20 s) mimo odczekania. |
| `OLX_HTTP_403` / `405` / `429`, `OLX_HUMAN_VERIFICATION` | OLX odmówił dostępu; bez ponowień i obchodzenia. |
| `OLX_JOB_LEASE_LOST`, `OLX_JOB_DURATION_LIMIT`, `OLX_WORKER_ERROR` | Jak w workerze lokalnym. |

## 7. Warianty awaryjne

- **Worker lokalny Windows** (`npm run olx-worker`): działa równolegle bez konfliktu.
  Przy `leave_queued` przejmuje zadania po wyczerpaniu budżetu Cloudflare.
- **Railway** (PR #3, `workers/olx-browser/Dockerfile`): niewdrożony, gotowy jako wariant płatny.
- **Workers Paid** (5 USD/mies.): ten sam kod. Wystarczy podnieść
  `OLX_CLOUD_DAILY_BROWSER_LIMIT_SECONDS` / `OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS` i
  `OLX_CLOUD_MAX_JOBS_PER_INVOCATION`.

## 8. Testy

```bash
cd workers/olx-cloudflare && npm test
```

- `test/olx-parser.fixture.test.ts`: parser Findera i pełna ścieżka „w stronie” na reprezentatywnej
  stronie wyników (`test/fixtures/olx-lodz-sprzedaz.sample.html`: 40 ofert, promowane, URL względny,
  brak ceny/dzielnicy/typu budynku, czas Unix, znaki specjalne). Ekstrakcja działa w prawdziwym
  Chromium, z JS i bez. Testy sprawdzają też zgodność bundla z parserem.
- `test/runner.integration.test.ts`: fikcyjna kolejka HTTP z produkcyjną weryfikacją HMAC i nonce,
  model stanów `olx-job-state.ts` i 90-sekundowy watchdog. Scenariusze: Finder + Radar w jednej sesji,
  idempotencja, budżet (na starcie, w trakcie, 429), limit sesji, 403/CAPTCHA, utrata lease, dzienny
  limit zadań, limit subrequestów, niedostępne API, zły sekret, odzysk po awarii, nowa doba.
- `test/scheduling.test.ts`: polityka alarmów i symulacja 24 h z opóźnionymi alarmami i utraconym
  alarmem względem limitu 90 s.

Chromium: testy używają `playwright` z katalogu głównego i `/opt/pw-browsers/chromium` albo
`OLX_TEST_CHROMIUM_PATH`. Bez przeglądarki testy przeglądarkowe są pomijane.
