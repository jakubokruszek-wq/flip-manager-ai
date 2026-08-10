# OLX local browser worker — etap 1

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

Autostart Windows i scheduler nie należą do etapu 1.
