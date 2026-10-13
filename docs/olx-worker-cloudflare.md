# OLX worker na Cloudflare Workers Free + Browser Run

Wariant podstawowy workera OLX: bez komputera, 0 zł/mies. Kod jest w `workers/olx-cloudflare/`.
Lokalny worker Windows (`workers/olx-browser`) i wariant Railway (PR #3) pozostają bez zmian jako
warianty awaryjne. Railway nie jest wdrażany.

> Status: **nie wdrożono**. Wdrożenie przebiega etapami, każdy wymaga zatwierdzenia:
> 1. **Etap 1 — wyłącznie testowy, osobny Worker `flip-manager-olx-cloud-stage1`** (istniejący
>    `flip-manager-olx-cloud` nietknięty). Zero pobierania zadań. Instrukcja:
>    [`olx-worker-cloudflare-etap1.md`](olx-worker-cloudflare-etap1.md).
> 2. **Etap 2 — ograniczony test produkcyjny.** Tryb `manual`, jedno zadanie jednego filtra (§6).
> 3. **Etap 3 — praca ciągła.** Tryb `auto`.

## 1. Jak to działa

```
Finder / Radar (Vercel)                       Cloudflare (Free)
──────────────────────                        ──────────────────────────────────────────────
enqueue → olx_scan_jobs (Supabase)            Cron Trigger (co 1 min): tylko przywraca alarm (tryb auto)
                │   HTTPS + HMAC                    │
   /api/olx-worker/claim  ◄──────────────  Durable Object "olx-runner" (jedna instancja)
   /api/olx-worker/heartbeat ◄───────────     auto: alarm 20 s → 40 s bez zadań, ~1 s po pracy
   /api/olx-worker/complete  ◄───────────     manual: wyłącznie POST /run-once?filterId=…
   /api/olx-worker/fail      ◄───────────     budżet przeglądarki + pauzy (ledger w SQLite DO)
                                              ▼
                                           Browser Run (@cloudflare/playwright)
                                              w stronie: PRERENDERED_STATE → parser Findera (bundle)
                                              → stabilne ID, rozmiary zdjęć → weryfikacja
```

- **Kolejka bez zmian.** Te same endpointy `/api/olx-worker/*`: HMAC + nonce, lease 120 s, heartbeat co
  30 s, `complete`/`fail` związane z lease (dla Radaru także z `radarLeaseToken`). Logika zadania to
  współdzielony `runOlxJob` z `workers/olx-browser`, importowany bez modyfikacji. Worker nie zapisuje
  ogłoszeń: w Durable Object trzyma tylko licznik budżetu i diagnostykę.
- **Tryby odbioru** (`OLX_CLOUD_CLAIM_MODE`):
  - `manual` (domyślnie): alarm i Cron niczego nie pobierają; `/run-once?jobId=…|filterId=…` używa
    wyłącznie atomowego claimu selektywnego (§6);
  - `auto`: alarm co 20 s, po kolejnych pustych odpowiedziach co 40 s, ~1 s po pracy.
    Cron (co 1 min) tylko przywraca utracony alarm.
- **Parsowanie w przeglądarce.** `window.__PRERENDERED_STATE__` jest czytany z oryginalnego skryptu
  inline. Parser Findera (zbundlowany esbuildem, bez zmian w kodzie Findera) wykonuje się
  w przeglądarce Browser Run. Worker przekazuje gotowy JSON do `/complete` bez parsowania.
- **Brak parsowania zapasowego w Workerze.** Jeśli parser w przeglądarce zawiedzie z innego powodu niż
  zmiana kształtu strony, zadanie kończy się kodem `OLX_CLOUD_IN_PAGE_PARSER_FAILED`. Workera nie
  obciąża się parsowaniem: 8–12 ms CPU przekroczyłoby limit, a wywołanie zabite za CPU straciłoby
  wszystkie trzymane zadania. Błędy parsera Findera (`OLX_PARSER_SHAPE_CHANGED`, „brak
  PRERENDERED_STATE”) zachowują dotychczasowe komunikaty.

## 2. Poprawki danych OLX (punkt 1 i 2 przeglądu)

### Stabilne ID ofert (`OLX_CLOUD_LISTING_ID_MODE`)

**Problem:** parser Findera akceptuje `ad.id` tylko jako string. OLX podaje liczbę, więc ID staje się
ostatnim segmentem URL, czyli slugiem tytułu (`mieszkanie-2-pokoje-…-CID3-IDxxxx.html`). Edycja tytułu
zmienia slug, a więc ID, i ta sama oferta jest zapisywana ponownie.

**Poprawka (w workerze, bez zmian w Finderze):** ID = numeryczne `ad.id` z danych OLX. Gdy go brak,
używany jest token `ID…` z URL, który nie zależy od tytułu. `rawPayload`, `contentHash` i URL pozostają
bez zmian. Test: `stable id: a title edit (new slug URL) keeps the same id…`.

**Wpływ na zapisane dane:**
- **Finder:** szuka oferty po ID, a potem po `normalized_url`, i zachowuje zapisane ID. Istniejące
  oferty nie zdublują się. Oferta zapisana starym ID dostanie nowy rekord dopiero przy pierwszej
  zmianie tytułu, bo zmienia się wtedy także URL; potem ID jest stabilne. Bez zmiany jest gorzej:
  duplikat przy każdej edycji tytułu.
- **Radar:** szuka wyłącznie po `external_listing_id` (`price_radar_listings`,
  `price_radar_verification_queue`, `price_radar_district_queue`). Zmiana ID zdublowałaby oferty
  i „odrzuciła” odrzucenia. Dlatego:

| Wartość | Finder | Radar |
|---|---|---|
| `stable_finder` (domyślnie) | stabilne ID | dotychczasowe ID |
| `stable_all` | stabilne ID | stabilne ID (dopiero po migracji poniżej) |
| `legacy` | dotychczasowe | dotychczasowe (identycznie jak worker lokalny) |

**Do uzgodnienia z Radarem (niewykonane):** jednorazowa migracja przepisująca zapisane ID OLX na ID
z `raw_payload->>'id'`. Kolejność: najpierw kolejki (przez złączenie po starym ID), na końcu
`price_radar_listings`. Szkic dla tabeli ofert:

```sql
-- PROPOZYCJA, nie dodana do supabase/migrations. Wymaga zgody właścicieli Radaru.
update public.price_radar_listings l
   set external_listing_id = l.raw_payload->>'id'
 where l.source = 'olx'
   and jsonb_typeof(l.raw_payload->'id') = 'number'
   and l.external_listing_id <> l.raw_payload->>'id'
   and not exists (
     select 1 from public.price_radar_listings d
      where d.owner_id = l.owner_id and d.source = 'olx' and d.external_listing_id = l.raw_payload->>'id');
```

Po migracji ustaw `OLX_CLOUD_LISTING_ID_MODE="stable_all"`. Ta sama poprawka w parserze Findera
(`toOlxListing`) objęłaby też worker lokalny. To zmiana modułu Findera, więc również do uzgodnienia.

### Zdjęcia

**Problem:** linki zdjęć OLX to szablony `…/image;s={width}x{height}`. Parser Findera zostawia
szablon zakodowany w URL (`%7Bwidth%7Dx%7Bheight%7D`), którego CDN nie obsłuży. Kod aplikacji nigdzie
go nie podstawia.

**Poprawka:** worker podstawia rozmiar zdjęcia z tego samego ogłoszenia (`photos[].width/height`,
dopasowanie po ID pliku Apollo, np. `s=1200x900`). Domyślnie używa `1000x750`. Miniatura =
pierwsze zdjęcie. Nierozwiązany szablon daje ostrzeżenie `OLX_CLOUD_IMAGE_TEMPLATE_UNRESOLVED`.
Finder zastępuje listę zdjęć nową (`resolveListingImages`), więc poprawione adresy nadpiszą stare bez
duplikatów. Worker lokalny nadal wysyła stary format: przy pracy obu workerów zdjęcia mogą się
przełączać. Docelowo poprawka powinna trafić do parsera Findera (do uzgodnienia).

## 3. Limity Cloudflare Free — stan zweryfikowany w dokumentacji

Źródło: repozytorium dokumentacji Cloudflare (`cloudflare-docs`, gałąź `production`), 13.10.2026.

| Limit | Wartość na Free | Jak worker go respektuje |
|---|---|---|
| CPU Workera (HTTP, Cron) | **10 ms** na wywołanie; „isolate has some built-in flexibility … infrequently runs over”, przy regularnym przekraczaniu wywołanie jest przerywane (`exceededCpu`, błąd 1102) | Cron i `/health` wykonują ułamek ms. |
| CPU Durable Object (RPC, alarm) | Strona DO: „Durable Objects are a special kind of Worker, so Workers Limits apply according to your Workers plan”, FAQ: „same per invocation CPU limits as any Workers do”. Wartość 30 s dotyczy planu płatnego. **Przyjęto 10 ms na alarm.** | Parser w przeglądarce. Worker robi ~3 ms na zadanie (odpowiedź CDP + HMAC ~300 KB). ≤ 2 zadania na wywołanie. Brak parsowania zapasowego w Workerze. Rzeczywisty CPU trzeba potwierdzić w Workers Logs w etapie 2. |
| Czas ścienny alarmu | 15 min | Okno pobierania 4 min, zadanie ≤ 210 s. |
| Browser Run | 10 min/dzień (UTC), 3 równoległe, **1 nowa przeglądarka / 20 s**, timeout bezczynności 60 s. Po limicie: `429 Browser time limit exceeded for today`. | Stop przy 480 s (własny licznik + `history()`). Rezerwa 35 s na stronę. Jedna sesja na partię. `limits()` przed `launch`. 429 → pauza do północy UTC. |
| Subrequesty | 50 na wywołanie | Limit roboczy 45, rezerwa na zadanie i sesję. |
| Żądania | Workers 100 tys./dzień, DO 100 tys./dzień (z alarmami) | auto ≈ 2,2 tys. alarmów + 1,4 tys. cronów dziennie. |
| Czas pracy DO | 13 000 GB-s/dzień | Nawet ciągła praca 128 MB to 10 800 GB-s/dzień; realnie < 1 000. |
| Cron Triggers | 5 na konto | Używany 1. |

## 4. Koszt zapytań `claim` (Vercel + Supabase) — punkt 5

Każdy claim to jedna funkcja Vercel (`/api/olx-worker/claim`, Node). Wykonuje ona weryfikację HMAC
i 3 zapytania do Supabase: sprzątanie nonce'ów, zapis nonce'a, RPC `claim_olx_scan_job`.

| Polling | Claimy/dobę | Wywołania/mies. | Udział w Vercel Hobby (1 mln wywołań, 4 h Active CPU) |
|---|---|---|---|
| stały 20 s (pierwsza wersja) | ~4 320 | ~130 tys. | ~13% wywołań, Active CPU ~0,4–1,1 h (10–27%) przy 10–30 ms CPU na wywołanie |
| **20 s → 40 s (teraz, tryb auto)** | **~2 200** | **~66 tys.** | **~7% wywołań, ~0,2–0,55 h Active CPU** |
| tryb `manual` (etap 1–2) | 0 | 0 | 0 |

Dla porównania: istniejące harmonogramy GitHub Actions (4 × co 5 min) to już ~35 tys. wywołań
miesięcznie. Supabase Free nie liczy zapytań. Claim zwraca < 1 KB (transfer pomijalny), a tabela
nonce'ów jest sprzątana przy każdym żądaniu. Regularny ruch zapobiega też usypianiu projektu Free.
Szacunki CPU Vercel są przybliżone; rzeczywiste wartości są w panelu Vercel → Usage.

Optymalizacja bez zmiany kontraktu: polling adaptacyjny 20 s → 40 s
(`OLX_CLOUD_IDLE_POLL_MAX_SECONDS`, maks. 45 s). Symulacja 24 h: ~2 200 claimów na dobę, a najgorszy
odbiór zadania ~53 s przy alarmach spóźnionych do 15 s, wciąż poniżej 90 s Findera. Większa
oszczędność wymagałaby zmiany kontraktu, np. wybudzania workera przez Findera przy dodaniu zadania.
To tylko propozycja.

## 5. Bezpieczeństwo i automatyczne wyłączanie — punkt 7

- **Sekrety:** tylko `wrangler secret put` (`OLX_WORKER_SECRET`, `OLX_CLOUD_ADMIN_TOKEN`). W repozytorium
  nie ma żadnych sekretów, a `.dev.vars` jest ignorowany. `/status` i `/selftest` pokazują tylko „set /
  missing / too_short”, nigdy wartości. Komunikaty błędów konfiguracji podają nazwę zmiennej, nie jej
  treść. Lease tokeny nie trafiają do logów (test).
- **HMAC:** ten sam protokół co worker lokalny: znacznik czasu ±5 min, jednorazowy nonce, podpis metody,
  ścieżki i SHA-256 treści. Surowy `complete` podpisuje dokładnie wysyłany tekst. Testy z produkcyjnym
  weryfikatorem obejmują zły sekret (401) i replay (401).
- **Endpointy administracyjne** `/status`, `/run-once`, `/selftest` wymagają nagłówka
  `Authorization: Bearer <OLX_CLOUD_ADMIN_TOKEN>` (≥ 32 znaki, porównanie skrótów SHA-256). Bez tokenu
  zwracają 404. Publiczny jest tylko `/health`. `filterId` musi być UUID, a do wyrażenia w stronie trafia
  wyłącznie wartość z zamkniętej listy (`stable`/`legacy`).
- **Adresy:** zadania tylko na `https://(www.)olx.pl`. Przekierowanie poza olx.pl →
  `OLX_CLOUD_UNEXPECTED_REDIRECT` i strona nie jest parsowana. API tylko przez HTTPS.
- **Wyłączanie, od najmocniejszego:**
  - `OLX_CLOUD_STAGE1_LOCK=1` (Worker etapu 1): pobieranie zablokowane w kodzie niezależnie od innych zmiennych;
  - `OLX_CLOUD_ENABLED=0`: Cron usuwa alarm, `/run-once` jest odrzucany;
  - brak `OLX_WORKER_SECRET`: konfiguracja nieważna, nic nie jest pobierane;
  - `OLX_CLOUD_CLAIM_MODE=manual`: żadnego pobierania automatycznego;
  - pauza budżetowa (480 s albo 429 Cloudflare) do północy UTC;
  - **pauza po odmowach OLX:** 2 kolejne odpowiedzi 403/405/429 albo strona weryfikacji wstrzymują
    pobieranie na 6 h (`OLX_CLOUD_OLX_ACCESS_PAUSED`, przetrwa północ). Zabezpieczenia OLX nie są
    obchodzone;
  - dzienny limit zadań (`OLX_CLOUD_MAX_JOBS_PER_DAY`).

  Zmiana zmiennych wymaga `wrangler deploy`. Trwająca partia (≤ 2 zadania) kończy się normalnie,
  następny alarm już się nie uruchomi.

## 6. Etap 2 — ograniczony test produkcyjny (do zatwierdzenia)

### Problem w poprzedniej wersji (commit 85e0367)

Test ręczny wywoływał zwykły claim, czyli `claim_olx_scan_job`. Ten zawsze bierze **najstarsze**
zadanie i przy okazji odzyskuje cudze wygasłe lease (UPDATE innych wierszy). Dopiero potem worker
sprawdzał filtr i cudze zadanie kończył jako FAILED (`OLX_CLOUD_TEST_FOREIGN_JOB`). Test zmieniał więc
stan cudzych zadań. Ten mechanizm został **usunięty**.

### Rozwiązanie: atomowy, selektywny claim

| Element | Plik | Status |
|---|---|---|
| Funkcja SQL `claim_olx_scan_job_selective(worker_id, job_id, search_filter_id, lease_seconds)` | `supabase/migrations/20261013150000_add_selective_olx_claim.sql` | **przygotowana, NIE wykonana** |
| Endpoint `POST /api/olx-worker/claim-selective` (ten sam HMAC co `/claim`) | `app/api/olx-worker/claim-selective/route.ts`, `features/flip-finder/server/olx-selective-claim.ts` | nowe pliki; aktywne po wdrożeniu aplikacji |
| Worker: tryb `manual` używa wyłącznie tego endpointu | `workers/olx-cloudflare/src/selective-claim-client.ts`, `runner.ts` | w PR |

Gwarancje funkcji (test na wbudowanym PostgreSQL, `test/selective-claim.rpc.test.ts`):
- blokuje (`FOR UPDATE SKIP LOCKED`) wyłącznie zadanie `queued` z `context_type = 'finder'` o podanym
  `job_id` albo `search_filter_id`; dokładnie jeden selektor jest wymagany;
- **nie zmienia żadnego innego wiersza**: nie odzyskuje ani nie wyczerpuje cudzych lease. Test porównuje
  pełną treść wierszy starszego zadania Radaru, starszego zadania innego filtra i zadania z wygasłym
  lease przed i po;
- zadania Radaru nie da się pobrać nawet po jawnym `job_id`;
- nie konkuruje ze zwykłymi workerami: dzięki `SKIP LOCKED` zadanie pobiera dokładnie jeden z nich;
- ustawia lease identycznie jak `claim_olx_scan_job`, więc heartbeat, `complete` i `fail` działają
  bez zmian;
- wykonać ją może tylko `service_role`;
- istniejąca funkcja `claim_olx_scan_job`, endpoint `/claim`, worker lokalny i Railway są bez zmian.

Zachowanie workera w trybie `manual`:
- `POST /run-once?jobId=<uuid>` lub `?filterId=<uuid>` (dokładnie jedno) → jeden claim selektywny;
- zwykły `/claim` nie jest wywoływany nigdy (sprawdzone w testach i w `workerd`);
- brak migracji → endpoint odpowiada `503 OLX_SELECTIVE_CLAIM_UNAVAILABLE`, nic nie jest pobierane
  (`summary.claimError`);
- przy aktywnej pauzie (budżet albo OLX) nie ma żadnego żądania do kolejki;
- jeśli serwer zwróciłby niepasujące zadanie (co według testów jest niemożliwe), worker go nie
  przetwarza i nie oznacza jako błędne; lease wygasa i zadanie wraca do kolejki zwykłą drogą.

### Przebieg etapu 2 (po zatwierdzeniach z §6a)

1. W głównym `wrangler.toml` ustaw `OLX_CLOUD_ENABLED="1"` (tryb pozostaje `manual`),
   `OLX_CLOUD_MAX_JOBS_PER_DAY="2"`, `OLX_CLOUD_MAX_JOBS_PER_INVOCATION="1"` i
   `OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS="120"`. Ustaw sekret `OLX_WORKER_SECRET`. Wdróż na Worker
   wskazany w zatwierdzeniu.
2. W Finderze uruchom ręcznie skan jednego filtra OLX (Łódź).
3. Odczytaj ID zadania (Supabase, tylko odczyt):
   ```sql
   select id, status, created_at from public.olx_scan_jobs
    where search_filter_id = '<UUID filtra>' and status = 'queued'
    order by created_at desc limit 1;
   ```
4. W ciągu 60 s:
   `curl -X POST -H "authorization: Bearer $T" "$W/run-once?jobId=<id zadania>"`.
5. Sprawdź w Finderze oferty, ceny, metraże, dzielnice, daty i zdjęcia. W Workers Logs sprawdź CPU time
   (< 10 ms) i brak `exceededCpu`; w `/status` zużycie przeglądarki.
6. Wycofanie: `OLX_CLOUD_ENABLED="0"` + deploy.

Kontrola kolejki przed testem nie jest już warunkiem bezpieczeństwa (claim selektywny nie dotyka cudzych
zadań), ale pomaga zinterpretować wynik.

### 6a. Zatwierdzenia wymagane przed etapem 2

1. **Migracja Supabase** `20261013150000_add_selective_olx_claim.sql`: jedna nowa funkcja, bez zmian
   danych. Zgoda właściciela bazy i Findera, wykonanie w SQL Editor albo `supabase db push`.
2. **Wdrożenie aplikacji** z endpointem `/api/olx-worker/claim-selective`. Nowe pliki w module
   kolejki OLX. Zgoda właściciela Findera, merge PR #5 albo osobny deploy.
3. **Docelowy Worker** dla etapu 2: istniejący `flip-manager-olx-cloud` (nadpisuje jego kod, zmienne
   i dodaje migrację DO bez możliwości rollbacku) albo nowy, osobny Worker.
4. **Okno testu i filtr testowy:** który filtr Łodzi, kiedy, czy worker lokalny ma być zatrzymany.
5. **Zgoda na pobranie jednego zadania** (`ENABLED=1`, `manual`, `MAX_JOBS_PER_DAY=2`).

## 7. Diagnostyka

`GET /status` (Bearer) zwraca:
- `configCheck`: wyłącznik, poprawność, obecność sekretów;
- `ledger`: zużycie dnia;
- `paused`, `nextAlarm`, `lastCron`, `lastWork`, `lastError` i `recent` (40 zdarzeń).

`POST /selftest` (Bearer) sprawdza URL, sekret i HMAC przez heartbeat dla losowego, nieistniejącego
zadania. Aplikacja odpowiada 409 `OLX_JOB_LEASE_LOST` i nie zmienia żadnego wiersza; jedyny zapis to
jednorazowy nonce. `?browser=1` dodatkowo otwiera i zamyka pustą przeglądarkę (bez wizyty na żadnej
stronie, kilka sekund z budżetu dnia).

| Kod w `olx_scan_jobs.error_code` | Znaczenie |
|---|---|
| `OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED` | Bezpieczny budżet dnia wyczerpany; wznowienie o północy UTC. |
| `OLX_CLOUD_BROWSER_DAILY_LIMIT_429` | Cloudflare odrzucił sesję (limit planu); pauza do północy UTC. |
| `OLX_CLOUD_OLX_ACCESS_PAUSED` | OLX odmówił dostępu kilka razy z rzędu; pauza na kilka godzin. |
| `OLX_CLOUD_DAILY_JOB_CAP_REACHED` | Osiągnięty `OLX_CLOUD_MAX_JOBS_PER_DAY`. |
| `OLX_CLOUD_IN_PAGE_PARSER_FAILED` | Błąd parsera w przeglądarce (nie kształtu strony); bez parsowania w Workerze. |
| `OLX_CLOUD_UNEXPECTED_REDIRECT` | OLX przekierował poza olx.pl. |
| `OLX_CLOUD_BROWSER_RATE_LIMITED` | Limit nowych sesji (1/20 s) mimo odczekania. |
| `OLX_HTTP_403` / `405` / `429`, `OLX_HUMAN_VERIFICATION` | OLX odmówił dostępu; bez ponowień i obchodzenia. |

## 8. Zmienne

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `OLX_CLOUD_ENABLED` | `0` | Wyłącznik główny. |
| `OLX_CLOUD_STAGE1_LOCK` | brak (`1` w `wrangler.stage1.toml`) | Trwała blokada pobierania dla Workera etapu 1. |
| `OLX_CLOUD_CLAIM_MODE` | `manual` | `manual` / `auto` (§1, §6). |
| `OLX_CLOUD_LISTING_ID_MODE` | `stable_finder` | §2. |
| `OLX_WORKER_API_URL` | `https://flip-manager-ai.vercel.app` | Adres aplikacji. |
| `OLX_CLOUD_WORKER_ID` | `cloudflare-olx-1` | `worker_id` w kolejce. |
| `OLX_CLOUD_IDLE_POLL_SECONDS` / `_MAX_SECONDS` | `20` / `40` | Polling w trybie auto (10–45 s). |
| `OLX_CLOUD_DAILY_BROWSER_LIMIT_SECONDS` | `600` | Limit planu. |
| `OLX_CLOUD_SAFE_BROWSER_BUDGET_SECONDS` | `480` | Własny próg zatrzymania. |
| `OLX_CLOUD_SCRAPE_RESERVE_SECONDS` | `35` | Rezerwa przed otwarciem strony. |
| `OLX_CLOUD_SESSION_MAX_SECONDS` / `KEEP_ALIVE_SECONDS` | `45` / `20` | Sesja Browser Run. |
| `OLX_CLOUD_MAX_JOBS_PER_DAY` | `0` | Limit dzienny (0 = brak). |
| `OLX_CLOUD_MAX_HELD_JOBS` / `MAX_JOBS_PER_INVOCATION` | `2` / `2` | Limit CPU wywołania. |
| `OLX_CLOUD_ON_BUDGET_EXHAUSTED` | `fail_jobs` | `fail_jobs` / `leave_queued` (dla workera awaryjnego). |
| `OLX_CLOUD_REFUSAL_PAUSE_THRESHOLD` / `_HOURS` | `2` / `6` | Pauza po odmowach OLX. |
| `OLX_CLOUD_BLOCK_HEAVY_RESOURCES` | `1` | Blokada obrazów, fontów i trackerów (CDP). |
| `OLX_CLOUD_PAGE_JAVASCRIPT` | `0` | `1` = uruchamiaj skrypty strony OLX. |
| `OLX_CLOUD_RESTRICT_TO_OLX_DOMAINS` | `0` | Guardrail Browser Run tylko na olx.pl. |

Sekrety: `OLX_WORKER_SECRET` (ten sam co w Vercel), `OLX_CLOUD_ADMIN_TOKEN`.

## 9. Testy

```bash
cd workers/olx-cloudflare && npm ci && npm test && npm run typecheck && npm run build:check
```

- `test/olx-parser.fixture.test.ts` (18 testów): reprezentatywna strona wyników, ekstrakcja i parser
  w prawdziwym Chromium (z JS i bez), zgodność bundla, stabilne ID przy edycji tytułu, zdjęcia.
- `test/runner.integration.test.ts` (29 testów): fikcyjna kolejka HTTP z produkcyjną weryfikacją HMAC
  i nonce, model stanów Findera i watchdog 90 s. Obejmuje:
  - Finder + Radar, idempotencję;
  - budżet i 429, pauzę po odmowach OLX;
  - test ręczny: przy kolejce ze starszym zadaniem Radaru i starszym zadaniem innego filtra
    przetwarzane jest wyłącznie wskazane zadanie (po `jobId` i po `filterId`), bez migracji nic nie
    jest pobierane, przy pauzie nie ma żadnego żądania;
  - brak parsowania zapasowego w Workerze, przekierowanie;
  - politykę ID, self-test.
- `test/selective-claim.rpc.test.ts` (5 testów): funkcja SQL claimu selektywnego na wbudowanym
  PostgreSQL, z prawdziwą migracją kolejki.
- `test/stage1-config.test.ts` (3 testy): osobna nazwa Workera etapu 1, blokada i zgodność konfiguracji.
- `test/scheduling.test.ts` (7 testów): symulacja 24 h z pollingiem adaptacyjnym, opóźnionymi i
  utraconymi alarmami oraz liczbą claimów na dobę.

CI (`.github/workflows/olx-cloudflare-worker.yml`) uruchamia testy, typecheck, kontrolę bundla i
`wrangler deploy --dry-run`. Niczego nie wdraża i nie ma dostępu do sekretów.

## 10. Warianty awaryjne

- **Worker lokalny Windows** (`npm run olx-worker`): działa równolegle bez konfliktu (`FOR UPDATE SKIP
  LOCKED`). Przy `leave_queued` przejmuje zadania po wyczerpaniu budżetu Cloudflare.
- **Railway** (PR #3): niewdrożony.
- **Workers Paid** (5 USD/mies.): ten sam kod z wyższymi limitami.
