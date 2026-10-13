# Etap 1 — testowe wdrożenie na istniejący Worker `flip-manager-olx-cloud`

Cel: wdrożyć kod z PR #5 na istniejące konto Cloudflare i istniejący Worker `flip-manager-olx-cloud`
**bez pobierania jakichkolwiek zadań**. Sprawdzamy `/health`, `/status` i konfigurację.

Gwarancje etapu 1 (sprawdzone w lokalnym runtime `workerd`):

| Mechanizm | Efekt |
|---|---|
| `OLX_CLOUD_ENABLED = "0"` | Cron co minutę tylko loguje `CRON_TICK_INACTIVE` i usuwa alarm. `/run-once` zwraca `OLX_CLOUD_DISABLED`. Nie ma żadnego wywołania `claim`. |
| `OLX_CLOUD_CLAIM_MODE = "manual"` | Nawet po włączeniu nic nie jest pobierane automatycznie. |
| Krok 1a: bez sekretu `OLX_WORKER_SECRET` | Konfiguracja jest nieważna, więc nie ma podpisanych żądań do aplikacji, nawet przy błędzie w zmiennych. |
| Brak zmian w Vercel, Supabase, Finderze i Radarze | Kolejka, harmonogramy i worker lokalny działają jak dotąd. |

Nie uruchamiaj `/run-once` w etapie 1. Etap 2 (§6 w `olx-worker-cloudflare.md`) wymaga osobnej zgody.

## 0. Przygotowanie (lokalnie)

```bash
git fetch origin claude/olx-cloudflare-workers-gkzda7
git checkout claude/olx-cloudflare-workers-gkzda7
cd workers/olx-cloudflare
npm ci
npm test                  # oczekiwane: wszystkie testy „pass” (testy przeglądarkowe wymagają Chromium)
npm run typecheck
```

Na Windows w PowerShell te same polecenia działają bez zmian. Wymagany jest Node 22+.

## 1. Logowanie i kontrola konta

```bash
npx wrangler login
npx wrangler whoami        # sprawdź nazwę konta i Account ID
```

Jeśli masz kilka kont, ustaw `CLOUDFLARE_ACCOUNT_ID` (zmienna środowiskowa w terminalu, nie w repozytorium).

## 2. Zabezpieczenie obecnego Workera testowego (ważne)

Wdrożenie dodaje Durable Object (migracja `v1`, klasa `OlxCloudRunner`). **Cloudflare nie pozwala potem
wrócić rollbackiem do wersji sprzed tej migracji.** Zanim wdrożysz:

1. Panel Cloudflare → **Workers & Pages** → `flip-manager-olx-cloud`:
   - **Edit code**: skopiuj obecny kod testowego Workera do pliku lokalnego, jeśli chcesz go zachować;
   - **Settings → Variables and Secrets**: zanotuj zmienne. `wrangler deploy` zastąpi zmienne panelu
     wartościami z `wrangler.toml`. Sekrety pozostają bez zmian;
   - **Settings → Bindings**: Browser Run powinien być dostępny. Wdrożenie doda `BROWSER` i `OLX_RUNNER`;
   - **Settings → Triggers**: istniejące Cron Triggers zostaną zastąpione jednym `* * * * *`
     (limit Free: 5 na konto);
   - **Settings → Domains & Routes**: zanotuj ewentualne trasy. Ten Worker potrzebuje tylko `workers.dev`.
2. Lista wersji i sekretów (sekrety tylko z nazwy):
   ```bash
   npx wrangler deployments list
   npx wrangler secret list
   ```
   Jeśli istnieje sekret `OLX_WORKER_SECRET` z wcześniejszych testów, na etap 1a usuń go
   (`npx wrangler secret delete OLX_WORKER_SECRET`). Zostanie ustawiony świadomie w kroku 6.
3. Jeśli istniejący Worker ma już Durable Objects z migracją o tagu `v1`, deploy zakończy się błędem
   i niczego nie zmieni. Wtedy przerwij i zgłoś to do korekty konfiguracji.

## 3. Kontrola konfiguracji przed wdrożeniem

W `workers/olx-cloudflare/wrangler.toml` (bez zmian względem PR) muszą być:

```toml
name = "flip-manager-olx-cloud"
OLX_CLOUD_ENABLED = "0"
OLX_CLOUD_CLAIM_MODE = "manual"
OLX_WORKER_API_URL = "https://flip-manager-ai.vercel.app"
```

Podgląd bez wysyłania (wymagany: `env.OLX_CLOUD_ENABLED ("0")` i `env.OLX_CLOUD_CLAIM_MODE ("manual")`):

```bash
npx wrangler deploy --dry-run --outdir dist
```

## 4. Wdrożenie (po Twoim zatwierdzeniu)

```bash
npx wrangler deploy
```

Zanotuj adres `https://flip-manager-olx-cloud.<subdomena>.workers.dev` i ID wersji.

## 5. Token administracyjny i weryfikacja (etap 1a — bez sekretu aplikacji)

```bash
openssl rand -hex 32                          # zapisz w menedżerze haseł
npx wrangler secret put OLX_CLOUD_ADMIN_TOKEN # wklej token
```

W PowerShell bez `openssl`:
`-join ((48..57)+(97..102) | Get-Random -Count 64 | % {[char]$_})`.

Weryfikacja (`W` = adres workers.dev, `T` = token):

```bash
curl -s "$W/health"
# {"ok":true,"service":"flip-manager-olx-cloud"}

curl -s -o /dev/null -w "%{http_code}\n" "$W/status"
# 404  (bez tokenu endpoint „nie istnieje”)

curl -s -H "authorization: Bearer $T" "$W/status"
```

Oczekiwane w `/status`:
- `"ok": false`, `"code": "OLX_CLOUD_DISABLED"`;
- `configCheck.killSwitch = "disabled"`, `configCheck.adminToken = "set"`;
- `configCheck.workerSecret = "missing"` i `configCheck.valid = false`. W etapie 1a to poprawne:
  bez sekretu nic nie może się podpisać;
- `nextAlarm: null`, `running: false`, `ledger: null`;
- `lastCron` aktualizowany co ~1 min (Cron działa). Gdy DO jeszcze się nie obudził, pole może być
  puste; poczekaj 2 minuty.

Logi na żywo (Ctrl+C kończy):

```bash
npx wrangler tail --format pretty
```

Co minutę powinno pojawić się `CRON_TICK_INACTIVE` z kodem `OLX_CLOUD_DISABLED`. Nie może być
`JOB_START`, `OLX_BROWSER_START`, `WORKER_POLL_ERROR` ani żadnego zdarzenia `claim`.

## 6. Etap 1b (opcjonalny) — sprawdzenie sekretu i HMAC bez pobierania zadań

Wymaga ustawienia sekretu aplikacji, ale nadal **nie pobiera zadań** (`OLX_CLOUD_ENABLED="0"`):

```bash
npx wrangler secret put OLX_WORKER_SECRET     # ten sam co OLX_WORKER_SECRET w Vercel
curl -s -H "authorization: Bearer $T" "$W/status"   # configCheck.valid = true, workerSecret = "set"
curl -s -X POST -H "authorization: Bearer $T" "$W/selftest"
```

Oczekiwane: `"queueApi": {"ok": true, "status": 409, ...}`.

`/selftest` wysyła jeden podpisany heartbeat dla losowego, nieistniejącego zadania. Aplikacja
sprawdza podpis, nie znajduje zadania i odpowiada 409 `OLX_JOB_LEASE_LOST` bez zmiany żadnego wiersza.
Jedyny zapis to jednorazowy nonce HMAC, usuwany automatycznie po 5 minutach.

| Wynik `queueApi` | Znaczenie |
|---|---|
| `ok: true`, 409 | Adres, sekret i zegar są poprawne. |
| 401 `INVALID_SIGNATURE` | Inny sekret niż w Vercel. |
| 401 `EXPIRED_REQUEST` | Problem z zegarem. |
| 503 `OLX_WORKER_NOT_CONFIGURED` | Vercel nie ma `OLX_WORKER_SECRET`. |

Opcjonalnie: test samej przeglądarki (pusta strona, bez wizyty na OLX, kilka sekund z dziennych 600 s):

```bash
curl -s -X POST -H "authorization: Bearer $T" "$W/selftest?browser=1"
```

Oczekiwane: `"browserRun": {"ok": true, "browserMs": …}`. W `/status` pojawi się `ledger` z
`sessions: 1` i małym `browserMs`.

## 7. Kryteria zaliczenia etapu 1

- [ ] `/health` → 200, `/status` bez tokenu → 404.
- [ ] `/status`: `OLX_CLOUD_DISABLED`, `killSwitch: disabled`, `nextAlarm: null`; po etapie 1b także
      `config.claimMode: "manual"` (sekcja `config` pojawia się, gdy konfiguracja jest kompletna).
- [ ] `wrangler tail`: tylko `CRON_TICK_INACTIVE`, żadnych zdarzeń zadań.
- [ ] Supabase (tylko odczyt): brak zadań z `worker_id` zaczynającym się od `cloudflare`:
      `select count(*) from public.olx_scan_jobs where worker_id like 'cloudflare%';` → `0`.
- [ ] (1b) `/selftest` → `queueApi.ok = true`.
- [ ] (opcjonalnie) `/selftest?browser=1` → `browserRun.ok = true`.

Prześlij mi wynik `/status`, `/selftest` i fragment `wrangler tail`. Na tej podstawie przygotuję
etap 2 do Twojej decyzji.

## 8. Wyłączenie / wycofanie

- Worker w etapie 1 niczego nie pobiera, więc pozostawienie go jest bezpieczne.
- Całkowite zatrzymanie Crona: panel → `flip-manager-olx-cloud` → **Settings → Triggers** → usuń
  `* * * * *`. Wróci przy następnym `wrangler deploy`.
- Usunięcie sekretów: `npx wrangler secret delete OLX_WORKER_SECRET` (i `OLX_CLOUD_ADMIN_TOKEN`).
- Usunięcie Workera: `npx wrangler delete`. Usuwa też Durable Object z licznikiem budżetu; danych
  ofert to nie dotyczy, bo są w Supabase.
- Rollback do testowego Workera sprzed migracji Durable Objects nie jest możliwy. Wrócić można,
  wklejając zachowany kod (krok 2) jako nową wersję w panelu.
