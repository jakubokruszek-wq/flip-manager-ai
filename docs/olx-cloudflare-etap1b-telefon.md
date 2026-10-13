# Etap 1b OLX Cloudflare z telefonu — self-test Workera testowego

Workflow `.github/workflows/olx-cloudflare-stage1b-selftest.yml` sprawdza połączenie zablokowanego Workera
testowego `flip-manager-olx-cloud-stage1` z aplikacją. Kroki:

1. `GET /status` musi potwierdzić:
   - `STAGE1_LOCK=1`;
   - `ENABLED=0`;
   - tryb `manual`;
   - 0 zadań dziś;
   - obecny `OLX_WORKER_SECRET`;
   - brak aktywnego zadania i alarmu.

   Jeśli którykolwiek warunek nie jest spełniony, `/selftest` **nie zostanie wysłany**.
2. **Dokładnie jedno** `POST /selftest` z tokenem Bearer, bez `?browser=1` i bez ponawiania.
3. Odpowiedź musi zawierać `queueApi.ok = true` i `queueApi.status = 409` (`OLX_JOB_LEASE_LOST`).
4. Ponownie `GET /status`: Worker musi nadal być zablokowany i bezczynny.

Wynik pojawi się w **Summary** przebiegu.

**Co się dzieje w aplikacji:** `/selftest` wysyła jeden podpisany heartbeat dla losowego, nieistniejącego
zadania. Aplikacja sprawdza podpis HMAC, nie znajduje zadania i odpowiada 409 bez zmiany żadnego wiersza.
Jedyny zapis to jednorazowy nonce HMAC, usuwany automatycznie po 5 minutach.

**Czego nie ma:**
- żadnego żądania do OLX;
- pobierania zadań;
- przeglądarki;
- wdrożenia;
- zmian w Vercel, Supabase i ustawieniach Cloudflare.

Workflow uruchamia się wyłącznie ręcznie.

## Warunek wstępny: sekret aplikacji w Workerze testowym (ręcznie)

Po etapie 1 Worker testowy celowo nie ma sekretu aplikacji. Workflow go nie ustawia, bo nie modyfikuje
Cloudflare. Bez niego zatrzyma się przed `/selftest` z komunikatem o brakującym sekrecie.

1. Wartość: ten sam `OLX_WORKER_SECRET`, którego używa aplikacja w Vercel i worker lokalny.
   - Jeśli zmienna w Vercel jest oznaczona jako *Sensitive*, panel nie pokaże jej wartości. Użyj wtedy
     kopii z menedżera haseł albo z `.env.local` workera lokalnego.
   - **Nie generuj nowej wartości**: zmiana sekretu w Vercel odcięłaby worker lokalny.
2. Chrome → `dash.cloudflare.com` → **Workers & Pages** → **flip-manager-olx-cloud-stage1** → **Settings**
   → **Variables and Secrets** → **+ Add**.
3. **Type:** `Secret`, **Variable name:** `OLX_WORKER_SECRET`, **Value:** wklej → **Deploy**.

   Cloudflare zapisze nową wersję Workera z tym samym kodem i tymi samymi zmiennymi. Blokada
   `OLX_CLOUD_STAGE1_LOCK=1` pozostaje, więc Worker nadal nie może pobierać zadań.
4. Niczego innego w Workerze nie zmieniaj. Ustawienia `flip-manager-olx-cloud` (produkcyjnego) pozostają bez zmian.

## Uruchomienie

GitHub uruchamia ręcznie tylko workflow z gałęzi `main`.

1. Scal PR etapu 1b: aplikacja GitHub → **Pull requests** → PR „OLX Cloudflare: etap 1b…” → przejrzyj
   **Files changed** (2 pliki: workflow i ta instrukcja) → **Merge pull request** → **Confirm merge**.
2. **Actions** → **OLX Cloudflare — etap 1b (self-test Workera testowego)** → **Run workflow** (gałąź
   `main`) → **Run workflow**.
3. Otwórz przebieg → **Summary**. Oczekiwane:
   - nagłówek „OLX Cloudflare — etap 1b zaliczony”;
   - `/selftest`: `queueApi.ok: true`, `status: 409`, `browserRun: null`;
   - `/status` po teście: `OLX_CLOUD_STAGE1_LOCKED`, `stage1Lock: true`, `killSwitch: disabled`,
     `workerSecret: set`, `running: false`, `nextAlarm: null`, `ledger: null` (albo same zera).

Workflow przy każdym uruchomieniu wysyła jedno żądanie kontrolne. Nie uruchamiaj go wielokrotnie bez potrzeby.

## Gdy przebieg się nie powiedzie

| Komunikat | Znaczenie | Co zrobić |
|---|---|---|
| „nie ma sekretu OLX_WORKER_SECRET … /selftest NIE został wysłany” | Brak sekretu w Workerze testowym | Wykonaj „Warunek wstępny”. |
| `/status zwrócił HTTP 404` | Zły `OLX_CLOUD_ADMIN_TOKEN_STAGE1` albo Worker usunięty | Ponów etap 1 (workflow wdrożenia ustawia token). |
| „Stan Workera nie spełnia warunków etapu 1b” | Np. aktywne zadanie lub zmieniona konfiguracja | Prześlij log; nie uruchamiaj ponownie. |
| `queueApi … 401 INVALID_SIGNATURE` | Inny sekret niż w Vercel | Popraw `OLX_WORKER_SECRET` w Workerze testowym. |
| `queueApi … 401 EXPIRED_REQUEST` | Zegar | Prześlij log. |
| `queueApi … 503` | Aplikacja bez `OLX_WORKER_SECRET` | Sprawdź zmienne w Vercel (bez zmian w etapie 1b). |

## Po etapie 1b

Sekret w Workerze testowym może zostać, bo blokada nadal uniemożliwia pobieranie zadań. Można go też
usunąć w tym samym miejscu: **Variables and Secrets** → `OLX_WORKER_SECRET` → **Delete**.

Etap 2 (migracja `20261013150000`, endpoint `claim-selective`, test jednego zadania) wymaga osobnych zgód.
