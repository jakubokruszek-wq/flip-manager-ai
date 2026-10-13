# Etap 1 — testowe wdrożenie jako osobny Worker `flip-manager-olx-cloud-stage1`

Cel: sprawdzić kod z PR #5 na Twoim koncie Cloudflare **bez pobierania jakichkolwiek zadań** i **bez
zmian w istniejącym Workerze `flip-manager-olx-cloud`**. Weryfikujemy `/health`, `/status` i konfigurację.

Etap 1 to osobny Worker z własnym plikiem `workers/olx-cloudflare/wrangler.stage1.toml`. Ma własny kod,
zmienne, sekrety, przestrzeń Durable Object i migracje. Istniejący `flip-manager-olx-cloud` (kod,
zmienne, sekrety, triggery, migracje DO) pozostaje nietknięty.

Gwarancje (sprawdzone testami i w lokalnym runtime `workerd`):

| Mechanizm | Efekt |
|---|---|
| `OLX_CLOUD_STAGE1_LOCK = "1"` | Trwała blokada w kodzie. Cron, alarm i `/run-once` nie pobierają zadań **nawet po ustawieniu `OLX_CLOUD_ENABLED=1` w panelu** (`/status`: `OLX_CLOUD_STAGE1_LOCKED`). |
| `OLX_CLOUD_ENABLED = "0"`, `OLX_CLOUD_CLAIM_MODE = "manual"` | Druga i trzecia warstwa wyłączenia, jak w docelowej konfiguracji. |
| Etap 1a bez `OLX_WORKER_SECRET` | Worker nie wysyła ani jednego podpisanego żądania do aplikacji. |
| Brak zmian w Vercel, Supabase, Finderze i Radarze | Kolejka, harmonogramy i worker lokalny działają jak dotąd. Migracja `20261013150000` **nie jest potrzebna** w etapie 1. |

Nie uruchamiaj `/run-once`. W tym Workerze i tak zwraca `OLX_CLOUD_STAGE1_LOCKED`.

## Zatwierdzenia wymagane przed rozpoczęciem etapu 1

1. **Utworzenie nowego Workera** `flip-manager-olx-cloud-stage1` na Twoim koncie (Workers Free:
   limit 100 Workerów).
2. **Jeden Cron Trigger `* * * * *`** dla tego Workera (Workers Free: 5 na konto). Jeśli limit jest już
   wykorzystany, usuń sekcję `[triggers]` z `wrangler.stage1.toml` przed wdrożeniem. Etap 1 traci wtedy
   tylko sprawdzenie, że Cron jest bezczynny.
3. **Utworzenie sekretu `OLX_CLOUD_ADMIN_TOKEN`** w nowym Workerze.
4. **(Opcjonalny etap 1b)** wpisanie sekretu `OLX_WORKER_SECRET` (tego samego co w Vercel) do nowego
   Workera i jedno wywołanie `/selftest`. To jedno podpisane żądanie heartbeat do produkcyjnej aplikacji,
   bez pobrania i zmiany zadań; jedyny zapis to jednorazowy nonce HMAC.
5. **(Opcjonalny)** `/selftest?browser=1`: jedna pusta przeglądarka, kilka sekund z dziennych 600 s
   Browser Run, bez wizyty na OLX.

Nic poza powyższym. Nie są potrzebne: migracja Supabase, wdrożenie aplikacji ani zmiany w
`flip-manager-olx-cloud`.

## 0. Przygotowanie (lokalnie)

```bash
git fetch origin claude/olx-cloudflare-workers-gkzda7
git checkout claude/olx-cloudflare-workers-gkzda7
cd workers/olx-cloudflare
npm ci
npm test                  # oczekiwane: wszystkie testy „pass”
npm run typecheck
```

Na Windows w PowerShell te same polecenia działają bez zmian. Wymagany jest Node 22+.

## 1. Logowanie i kontrola konta

```bash
npx wrangler login
npx wrangler whoami
```

Sprawdź nazwę konta i Account ID. Przy kilku kontach ustaw `CLOUDFLARE_ACCOUNT_ID` tylko w terminalu.

## 2. Podgląd bez wysyłania

**Wszystkie polecenia etapu 1 zawierają `--config wrangler.stage1.toml`.** Bez tego parametru Wrangler
użyłby `wrangler.toml`, czyli istniejącego Workera `flip-manager-olx-cloud`.

```bash
npx wrangler deploy --dry-run --outdir dist-stage1 --config wrangler.stage1.toml
```

W wyniku muszą być: `env.OLX_CLOUD_STAGE1_LOCK ("1")`, `env.OLX_CLOUD_ENABLED ("0")` i
`env.OLX_CLOUD_CLAIM_MODE ("manual")`.

## 3. Wdrożenie (po zatwierdzeniu 1–2)

```bash
npx wrangler deploy --config wrangler.stage1.toml
```

Zanotuj adres `https://flip-manager-olx-cloud-stage1.<subdomena>.workers.dev`.

Upewnij się w panelu (Workers & Pages), że `flip-manager-olx-cloud` ma nadal tę samą datę ostatniego
wdrożenia co wcześniej.

## 4. Etap 1a — token administracyjny i weryfikacja (bez sekretu aplikacji)

```bash
openssl rand -hex 32        # zapisz w menedżerze haseł
npx wrangler secret put OLX_CLOUD_ADMIN_TOKEN --config wrangler.stage1.toml
```

W PowerShell bez `openssl`:
`-join ((48..57)+(97..102) | Get-Random -Count 64 | % {[char]$_})`.

Weryfikacja (`W` = adres workers.dev Workera etapu 1, `T` = token):

```bash
curl -s "$W/health"
# {"ok":true,"service":"flip-manager-olx-cloud"}

curl -s -o /dev/null -w "%{http_code}\n" "$W/status"
# 404 bez tokenu

curl -s -H "authorization: Bearer $T" "$W/status"
```

Oczekiwane w `/status`:
- `"code": "OLX_CLOUD_STAGE1_LOCKED"`;
- `configCheck.stage1Lock: true`, `configCheck.killSwitch: "disabled"`, `configCheck.adminToken: "set"`;
- `configCheck.workerSecret: "missing"` i `configCheck.valid: false`. W 1a to poprawne;
- `nextAlarm: null`, `running: false`, `ledger: null`;
- `lastCron` aktualizowany co ok. minutę (jeśli Cron jest włączony).

Logi na żywo (Ctrl+C kończy):

```bash
npx wrangler tail --config wrangler.stage1.toml --format pretty
```

Co minutę: `CRON_TICK_INACTIVE` z kodem `OLX_CLOUD_STAGE1_LOCKED`. Nie może być `JOB_START`,
`OLX_BROWSER_START`, `WORKER_POLL_ERROR` ani `claim`.

## 5. Etap 1b (opcjonalny) — sekret i HMAC bez pobierania zadań

```bash
npx wrangler secret put OLX_WORKER_SECRET --config wrangler.stage1.toml   # ten sam co w Vercel
curl -s -H "authorization: Bearer $T" "$W/status"
# configCheck.valid: true, workerSecret: "set"; config.workerId: "cloudflare-olx-stage1", config.claimMode: "manual"
curl -s -X POST -H "authorization: Bearer $T" "$W/selftest"
```

Oczekiwane: `"queueApi": {"ok": true, "status": 409, ...}`. To jeden podpisany heartbeat dla losowego,
nieistniejącego zadania. Aplikacja sprawdza podpis i odpowiada 409 `OLX_JOB_LEASE_LOST` bez zmiany
żadnego wiersza.

| Wynik `queueApi` | Znaczenie |
|---|---|
| `ok: true`, 409 | Adres, sekret i zegar są poprawne. |
| 401 `INVALID_SIGNATURE` | Inny sekret niż w Vercel. |
| 401 `EXPIRED_REQUEST` | Problem z zegarem. |
| 503 `OLX_WORKER_NOT_CONFIGURED` | Vercel nie ma `OLX_WORKER_SECRET`. |

Opcjonalnie: `curl -s -X POST -H "authorization: Bearer $T" "$W/selftest?browser=1"`. Oczekiwane:
`browserRun.ok: true` i kilka sekund w `ledger.browserMs`.

## 6. Kryteria zaliczenia etapu 1

- [ ] `/health` → 200, `/status` bez tokenu → 404.
- [ ] `/status`: `OLX_CLOUD_STAGE1_LOCKED`, `stage1Lock: true`, `killSwitch: disabled`, `nextAlarm: null`.
- [ ] `wrangler tail`: tylko `CRON_TICK_INACTIVE`.
- [ ] Supabase (tylko odczyt):
      `select count(*) from public.olx_scan_jobs where worker_id like 'cloudflare%';` → `0`.
- [ ] `flip-manager-olx-cloud` bez nowego wdrożenia (panel → Deployments).
- [ ] (1b) `/selftest` → `queueApi.ok = true`.
- [ ] (opcjonalnie) `/selftest?browser=1` → `browserRun.ok = true`.

Prześlij wynik `/status`, `/selftest` i fragment `wrangler tail`.

## 7. Usunięcie Workera etapu 1

Worker etapu 1 nie może niczego pobrać, więc może zostać. Usunięcie (bez wpływu na
`flip-manager-olx-cloud`, Supabase i Vercel):

```bash
npx wrangler delete --config wrangler.stage1.toml
```

## 8. Dalej (każdy krok osobno do zatwierdzenia — szczegóły w `olx-worker-cloudflare.md` §6a)

Etap 2 wymaga:
- migracji Supabase `20261013150000_add_selective_olx_claim.sql` (jedna nowa funkcja SQL, bez zmian danych);
- wdrożenia aplikacji z endpointem `/api/olx-worker/claim-selective`;
- wyboru docelowego Workera;
- okna testu i filtra;
- zgody na pobranie jednego zadania.

Bez migracji endpoint odpowiada 503 i nic nie jest pobierane.
