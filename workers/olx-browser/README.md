# OLX browser worker

**Chmura (Railway, działa przy wyłączonym komputerze):** zobacz [`docs/olx-worker-railway.md`](../../docs/olx-worker-railway.md) — Dockerfile, `railway.json`, zmienne, weryfikacja, wyłączenie workera Windows.

## Lokalnie (Windows)

Worker działa wyłącznie outbound: odpytuje HTTPS API Flip Managera, otwiera dozwolony URL OLX w świeżym headless Chromium i odsyła znormalizowane oferty. Nie otwiera lokalnego portu i nie używa profilu ani cookies użytkownika.

1. Skopiuj `.env.example` do `.env.local`.
2. Ustaw ten sam `OLX_WORKER_SECRET` lokalnie i w środowisku Vercel.
3. Ustaw `OLX_WORKER_API_URL` na publiczny adres aplikacji.
4. Po ręcznym wykonaniu migracji uruchom z katalogu głównego:

```powershell
npm run olx-worker
```

Jednorazowe odpytanie kolejki:

```powershell
$env:OLX_WORKER_ONCE='1'
npm run olx-worker
```

Opcjonalne zmienne (`OLX_WORKER_ID`, `OLX_WORKER_POLL_INTERVAL_MS`, `OLX_WORKER_BLOCK_COOLDOWN_MS`, `OLX_WORKER_STATUS_LOG_INTERVAL_MS`) i zachowanie przy błędach opisuje ten sam dokument.
