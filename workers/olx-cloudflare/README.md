# OLX worker — Cloudflare Workers Free + Browser Run

Odbiera zadania z kolejki `olx_scan_jobs` (przez `/api/olx-worker/*`, HMAC) bez komputera i bez płatnego
hostingu. Pełna instrukcja konfiguracji, wdrożenia (Wrangler), limitów Free i testu produkcyjnego:
[`docs/olx-worker-cloudflare.md`](../../docs/olx-worker-cloudflare.md).

```bash
npm ci
npm test            # parser na reprezentatywnej stronie + integracja z fikcyjną kolejką
npm run typecheck
npm run build:check # wrangler deploy --dry-run (bez wdrożenia)
```

Pliki:
- `src/index.ts` — Worker (Cron, `/health`, `/status`, `/run-once`) i Durable Object `OlxCloudRunner` (alarm).
- `src/runner.ts` — partia zadań: claim → wspólna sesja przeglądarki → `runOlxJob` (z `workers/olx-browser`).
- `src/budget.ts` — dzienny budżet Browser Run (stop przed limitem planu).
- `src/browser-session.ts` — sesja Browser Run, limity nowych sesji, rozliczanie czasu.
- `src/olx-page.ts`, `src/in-page-expression.ts` — ekstrakcja `PRERENDERED_STATE`, parser Findera w stronie, weryfikacja.
- `src/generated/in-page-bundle.ts` — bundel parsera (generowany: `node scripts/build-in-page-bundle.mjs`).
