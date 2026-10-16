# Worker OLX w chmurze (Railway)

Worker OLX (`workers/olx-browser`) działa jako osobna usługa Railway, niezależnie od komputera i telefonu. To ten sam worker co na Windows: odpytuje istniejącą kolejkę `olx_scan_jobs` w Supabase przez API Flip Managera (`/api/olx-worker/claim|heartbeat|complete|fail`, HMAC), otwiera adres OLX w świeżym headless Chromium i odsyła znormalizowane oferty. Nie ma drugiej kolejki ani nowej integracji OLX.

```
Finder / Radar (Vercel) ──enqueue──▶ Supabase olx_scan_jobs ◀──claim/heartbeat/complete/fail (HMAC, HTTPS)── Railway: worker OLX ──▶ www.olx.pl
```

- Worker **nie tworzy** zadań ani przebiegów Radaru. Zadania Findera i Radaru kolejkują ich własne moduły; worker tylko je odbiera i finalizuje.
- Połączenia wyłącznie wychodzące. Usługa nie potrzebuje publicznej domeny ani portu.
- Brak profilu, cookies i sesji użytkownika: każde zadanie to nowy, pusty kontekst przeglądarki.

## Pliki

| Plik | Rola |
| --- | --- |
| `workers/olx-browser/Dockerfile` | Obraz produkcyjny: `mcr.microsoft.com/playwright:v1.61.1-noble` (Node 24, Chromium zgodny z playwright 1.61.1, biblioteki systemowe), `tini` jako PID 1, użytkownik `pwuser` (bez roota). Kontekst budowania = katalog główny repo. |
| `.dockerignore` | Lista dozwolonych plików: do obrazu trafiają tylko `features/flip-finder`, `features/properties`, `workers/shared`, `workers/olx-browser/src` i lockfile. Żadnych `.env*`, testów ani `node_modules`. |
| `workers/olx-browser/railway.json` | Config-as-code Railway: builder Dockerfile, 1 replika, restart `ALWAYS`, bez usypiania, `watchPatterns`. |
| `workers/olx-browser/test/` | Testy kontenera (atrapa API z prawdziwym HMAC, fikstura OLX) oraz test wyścigu `claim_olx_scan_job` na prawdziwym PostgreSQL. |
| `.github/workflows/olx-worker-container.yml` | CI: testy jednostkowe, wyścig na PostgreSQL, budowa obrazu, testy kontenera. Bez sekretów i bez kontaktu z OLX/Production. |

## Zmienne środowiskowe (Railway → usługa → Variables)

| Zmienna | Wymagana | Wartość |
| --- | --- | --- |
| `OLX_WORKER_API_URL` | tak | Publiczny adres produkcyjny Flip Managera, np. `https://<twoja-domena>` (musi być HTTPS). Ta sama wartość co w lokalnym `.env.local` workera. |
| `OLX_WORKER_SECRET` | tak | **Ten sam** sekret co `OLX_WORKER_SECRET` w Vercel (min. 32 znaki). Wpisz go tylko w Railway Variables (najlepiej jako *sealed*). Nie commituj, nie wpisuj do Dockerfile. |
| `OLX_WORKER_ID` | nie | Np. `railway-olx`. Domyślnie `railway-<RAILWAY_REPLICA_ID>`. Widoczne w `olx_scan_jobs.worker_id`. |
| `OLX_WORKER_POLL_INTERVAL_MS` | nie | Domyślnie `10000`. Puste odpytania wydłużają przerwę do 60 s (Finder uznaje zadanie za nieodebrane po 90 s, więc nie podnoś powyżej ~25000). |
| `OLX_WORKER_BLOCK_COOLDOWN_MS` | nie | Domyślnie `900000` (15 min). Pierwsza pauza po 403/405/429/CAPTCHA; kolejne podwajają się do 8× (2 h). |
| `OLX_WORKER_STATUS_LOG_INTERVAL_MS` | nie | Domyślnie `300000` (5 min) — co tyle worker loguje `WORKER_STATUS`. |

Nie ustawiaj `OLX_WORKER_ONCE` w Railway (worker zakończyłby się po jednym odpytaniu).

## Wdrożenie przez GitHub (robisz to Ty — PR niczego nie wdraża)

1. Zmerguj PR do `main` (albo, do testu, wskaż gałąź PR w kroku 4).
2. Railway → **New Project** → **Deploy from GitHub repo** → `jakubokruszek-wq/flip-manager-ai`. Jeżeli Railway od razu zacznie budować z Nixpacks/Railpack i się wyłoży — to normalne, popraw ustawienia z kroku 3 i zrób *Redeploy*.
3. Usługa → **Settings**:
   - **Root Directory**: puste (`/`). Obraz potrzebuje `features/` z katalogu głównego.
   - **Config-as-code / Railway Config File**: `/workers/olx-browser/railway.json`. Plik ustawia builder Dockerfile, `dockerfilePath`, 1 replikę, restart `ALWAYS` i `watchPatterns` (redeploy tylko po zmianach workera/parsera OLX).
   - **Region**: najlepiej EU West (Amsterdam) — najbliżej OLX i Supabase w UE.
   - **Networking**: *nie* generuj domeny publicznej. Healthcheck HTTP nie jest używany.
   - (opcjonalnie) **Resource limits**: pamięć 1 GB wystarcza z zapasem (Chromium na czas jednego zadania + Node ~100–150 MB w spoczynku).
4. **Source → Branch**: `main` (do testu może być gałąź z PR).
5. **Variables**: dodaj `OLX_WORKER_API_URL`, `OLX_WORKER_SECRET` (i opcjonalnie `OLX_WORKER_ID=railway-olx`).
6. **Deploy**. W logach builda powinna pojawić się linia `IMAGE_SELF_CHECK_OK chromium=...` — obraz sam sprawdza, że wszystkie moduły się ładują, a Chromium startuje.

Lokalny worker Windows może działać równolegle w trakcie weryfikacji: kolejka (`for update skip locked` + lease z tokenem) wydaje każde zadanie tylko jednemu workerowi — potwierdza to test `test/claim-race.sh` i test „parallel workers” w kontenerze.

## Jak sprawdzić, że działa naprawdę

Logi są jednym obiektem JSON na linię (`level`, `message`, `event` + atrybuty). Wyjątek: współdzielony parser OLX (moduł Findera) wypisuje dodatkowo wielowierszowy blok `OLX_PARSER_SHAPE` — to diagnostyka parsera, nie błąd. W Railway → **Logs** można filtrować np. `@event:JOB_SUMMARY` albo `@level:error`.

1. **Start**: `WORKER_START` z `workerId` zaczynającym się od `railway-`. Brak `WORKER_CONFIG_ERROR` i `WORKER_POLL_ERROR`.
   - `WORKER_POLL_ERROR: INVALID_SIGNATURE` ⇒ inny `OLX_WORKER_SECRET` niż w Vercel.
   - `WORKER_POLL_ERROR: OLX_WORKER_NOT_CONFIGURED` ⇒ brak `OLX_WORKER_SECRET` w Vercel.
   - `WORKER_POLL_ERROR: fetch failed` / `WORKER_API_HTTP_404` ⇒ zły `OLX_WORKER_API_URL`.
2. **Dostępność**: co 5 min `WORKER_STATUS`: `state` (`idle` / `running_job` / `cooldown`), `lastPollOkAt`, `lastClaimAt`, `lastJob`, `totals` (`completed`, `failed`, `accessDenied`, `rawItems`, `normalizedItems`, `pollErrors`).
3. **Zadanie**: uruchom w aplikacji ręczny skan Findera z OLX (albo poczekaj na harmonogram). W logach kolejno: `JOB_START` → `JOB_HEARTBEAT` → `OLX_BROWSER_DONE` (status HTTP, liczba ofert) → `JOB_COMPLETE` → `JOB_SUMMARY` (`outcome`, `code`, `rawItems`, `normalizedItems`, `durationMs`).
4. **Supabase** (SQL editor, tylko odczyt):
   ```sql
   select created_at, status, attempts, worker_id, error_code, finished_at
     from public.olx_scan_jobs
    order by created_at desc
    limit 20;
   ```
   Zadania obsłużone w chmurze mają `worker_id` = `railway-...` i `status = 'completed'`.
5. **Test „komputer wyłączony”**: zatrzymaj lokalny worker (sekcja niżej), zamknij komputer, odczekaj na zaplanowany skan / uruchom skan z telefonu, potem zamknij też telefon. Wynik sprawdź później w aplikacji i w zapytaniu z pkt 4.

Dopiero gdy pkt 3–4 pokazują `completed` z `worker_id = railway-...` i niezerowym `rawItems`, OLX działa w chmurze.

## Wyłączenie lokalnego workera Windows (po potwierdzeniu chmury)

Nie używaj `scripts/uninstall-worker-autostart.ps1` — usuwa także zadanie **Facebooka**, który musi zostać lokalnie. Wyłącz tylko OLX (PowerShell jako ten sam użytkownik, który instalował autostart):

```powershell
Stop-ScheduledTask    -TaskName "FlipManager OLX Worker" -ErrorAction SilentlyContinue
Disable-ScheduledTask -TaskName "FlipManager OLX Worker"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'workers[\\/]olx-browser[\\/]src[\\/]index\.ts' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
powershell -ExecutionPolicy Bypass -File scripts\worker-status.ps1   # OLX: TaskState Disabled, brak procesu
```

Powrót do workera lokalnego: `Enable-ScheduledTask -TaskName "FlipManager OLX Worker"; Start-ScheduledTask -TaskName "FlipManager OLX Worker"`.

Uwaga: `scripts/restart-workers.ps1` restartuje oba zadania i zatrzyma się błędem na wyłączonym zadaniu OLX. Po wyłączeniu restartuj Facebooka bezpośrednio: `Stop-ScheduledTask` / `Start-ScheduledTask -TaskName "FlipManager Facebook Worker"`.

Wyłączenie workera chmurowego: Railway → usługa → **Settings → Remove service** albo w **Deployments** *Remove* aktywnego wdrożenia (zadania pozostają w kolejce; Finder po 90 s oznaczy je jako nieodebrane).

## Zachowanie przy błędach

| Sytuacja | Co robi worker |
| --- | --- |
| Pusta kolejka | Odpytuje co 10 s, przy braku zadań wydłuża przerwę do 60 s. |
| Błąd API / sieci | Loguje `WORKER_POLL_ERROR`, backoff do 60 s, próbuje dalej. |
| OLX 403/405/429, CAPTCHA („Human Verification”, Cloudflare, DataDome) | Zadanie kończy się `fail` z kodem (`OLX_HTTP_403`, `OLX_HUMAN_VERIFICATION`, …) **bez ponowienia**. Worker przechodzi w `cooldown` (15 min, potem 30, 60, 120 min) i loguje `WORKER_OLX_ACCESS_COOLDOWN`. Zadania odebrane w tym czasie są od razu zwalniane jako `OLX_ACCESS_COOLDOWN` z czytelnym powodem — bez otwierania OLX. Brak obchodzenia zabezpieczeń (żadnych proxy, rotacji IP, solverów CAPTCHA, podszywania się). |
| 3 kolejne nieudane zadania z innych przyczyn (np. timeout — typowy objaw blokady IP) | Ten sam cooldown z powodem `CONSECUTIVE_JOB_FAILURES`. |
| Utrata lease (heartbeat odrzucony) | Przerywa przeglądarkę, nie wysyła `complete`/`fail` (nie jest już właścicielem zadania). |
| Przekroczony czas zadania (210 s łącznie) | Przerywa i zgłasza `OLX_JOB_DURATION_LIMIT`, póki lease jest ważny. |
| SIGTERM (redeploy / restart w Railway) | Przerywa bieżące zadanie bez `fail`, kończy się kodem 0. Lease (120 s) wygasa i zadanie wraca do kolejki (maks. 3 próby). |
| Awaria / OOM / SIGKILL | Railway restartuje kontener (`ALWAYS`); zadanie wraca do kolejki po wygaśnięciu lease. |
| Zawieszenie pętli (nieobsłużony hang) | Watchdog loguje `WORKER_WATCHDOG_STALL` i kończy proces kodem 1 → restart. |
| Brak/niepoprawna konfiguracja | `WORKER_CONFIG_ERROR` (nazwa zmiennej, bez wartości) i kod 1. |

## Ograniczenia dostępu do OLX z chmury

- Railway wychodzi do internetu z adresów centrów danych. OLX (Cloudflare/DataDome) częściej odpowiada takim adresom 403 lub CAPTCHA niż łączu domowemu. To, czy OLX wpuści ruch z Railway, da się stwierdzić **dopiero po wdrożeniu** (pierwszy `JOB_SUMMARY`). Środowisko, w którym przygotowano ten PR, nie ma dostępu do OLX, więc nie zostało to sprawdzone.
- Jeśli OLX będzie trwale blokować Railway, worker nie będzie tego obchodził: zadania OLX skończą się `OLX_HTTP_403` / `OLX_HUMAN_VERIFICATION` / `OLX_ACCESS_COOLDOWN`, a reszta aplikacji (Otodom, Facebook) działa dalej. Legalne alternatywy: zostawić lokalny worker Windows jako jedyne/zapasowe źródło OLX albo oficjalne API partnerskie OLX.
- Worker pobiera jedną stronę wyników na zadanie, z co najmniej 10 s przerwy między zadaniami, w jednej replice — ruch jest porównywalny z ręcznym przeglądaniem.

## Szacunkowy koszt

Według cennika Railway znanego w momencie przygotowania (sprawdź aktualny na railway.com/pricing): plan Hobby 5 USD/mies. z 5 USD kredytu na zużycie; pamięć ok. 10 USD za GB·miesiąc, CPU ok. 20 USD za vCPU·miesiąc, transfer wychodzący ok. 0,05 USD/GB.

- Spoczynek: Node ~0,1–0,15 GB RAM, CPU ~0 → ok. 1,5 USD/mies.
- Zadania: Chromium ~0,4–0,6 GB i ~1 vCPU przez ~5–30 s na zadanie; przy kilkudziesięciu zadaniach dziennie to grosze.
- Transfer: kilka MB na zadanie → < 0,5 USD/mies.

Łącznie zwykle mieści się w kredycie planu Hobby: **ok. 5 USD/mies.** (ok. 20–25 zł), realnie do ~7 USD przy większej liczbie skanów. Obraz bazowy jest duży (~3,4 GB), co wydłuża pierwszy build, ale nie wpływa na koszt działania.

## Testy lokalne

```bash
npm ci --prefix workers/olx-browser --ignore-scripts
node --test --experimental-strip-types --experimental-test-module-mocks workers/olx-browser/src/*.test.ts workers/shared/*.test.ts
workers/olx-browser/test/claim-race.sh                                   # wymaga binarek PostgreSQL
docker build -f workers/olx-browser/Dockerfile -t flip-olx-worker:test .
OLX_CONTAINER_E2E=1 node --test --experimental-strip-types workers/olx-browser/test/container.e2e.test.ts
```
