# OLX worker — Cloudflare Workers Free + Browser Run

Odbiera zadania z kolejki `olx_scan_jobs` (przez `/api/olx-worker/*`, HMAC) bez komputera i bez płatnego
hostingu. Pełna instrukcja konfiguracji, wdrożenia (Wrangler), limitów Free i testu produkcyjnego:
[`docs/olx-worker-cloudflare.md`](../../docs/olx-worker-cloudflare.md). Etap 1 (wyłącznie testowy, bez
pobierania zadań) jako osobny Worker `flip-manager-olx-cloud-stage1` (`wrangler.stage1.toml`):
[`docs/olx-cloudflare-etap1-telefon.md`](../../docs/olx-cloudflare-etap1-telefon.md). Etap 2 (jedno zadanie
Findera wskazane po `jobId`, ręcznie z GitHub Actions) jako osobny Worker `flip-manager-olx-cloud-stage2`
(`wrangler.stage2.toml`): [`docs/olx-cloudflare-etap2-telefon.md`](../../docs/olx-cloudflare-etap2-telefon.md).

```bash
npm ci
npm test            # parser na reprezentatywnej stronie + integracja z fikcyjną kolejką
npm run typecheck
npm run build:check # wrangler deploy --dry-run (bez wdrożenia)
```

Pliki:
- `src/index.ts` — Worker (Cron, `/health`, `/status`, `/run-once`, `/selftest`) i Durable Object `OlxCloudRunner` (alarm, tryby `manual`/`auto`).
- `src/runner.ts` — partia zadań: claim → wspólna sesja przeglądarki → `runOlxJob` (z `workers/olx-browser`).
- `src/budget.ts` — dzienny budżet Browser Run (stop przed limitem planu).
- `src/browser-session.ts` — sesja Browser Run, limity nowych sesji, rozliczanie czasu.
- `src/olx-page.ts`, `src/in-page-expression.ts` — ekstrakcja `PRERENDERED_STATE`, parser Findera w stronie, weryfikacja.
- `src/listing-fixes.ts` — stabilne ID ofert OLX i rozmiary zdjęć (w przeglądarce, po parserze Findera).
- `src/selective-claim-client.ts` — test ręczny: atomowy claim tylko wskazanego zadania (`/api/olx-worker/claim-selective`).
- `src/self-test.ts` — `/selftest`: HMAC/URL/sekret bez pobierania zadań, opcjonalnie pusta przeglądarka.
- `src/generated/in-page-bundle.ts` — bundel parsera (generowany: `node scripts/build-in-page-bundle.mjs`).
