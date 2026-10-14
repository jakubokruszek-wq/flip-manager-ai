# Pełne oddzielenie OLX od skanowania Findera (14.10.2026)

## 1. Objaw (Production)

| | |
|---|---|
| Przebieg | `scan_run_id = 02e88883-970c-4a87-a646-90c540deb568`, 14.10.2026 20:49 (PL) |
| Zadanie OLX | `olx_scan_jobs.id = bb495d7a-87d4-4bae-b6a2-79e367deb656` |
| Wynik | etap OLX `failed`, `OLX_WORKER_CLAIM_TIMEOUT`; w postępie „OLX · surowe / poprawne” i błąd OLX |

## 2. Przyczyna

„Skanuj” (`startFinderScanForFilter`, origin `manual`) i `runManualOtodomScan` nadal dodawały zadanie OLX w starej kolejce (`enqueueOlxJob`, `requested_by = NULL`) jako 12. etap przebiegu.

- Worker `scheduled` (Cloudflare) bierze tylko zadania automatyczne (`requested_by = 'scheduler'`, migracja `20261017120000`).
- Lokalny worker OLX jest wyłączony.
- Zadania nikt nie odebrał, więc watchdog postępu (`scan-progress.ts`, 90 s) zamknął je jako `OLX_WORKER_CLAIM_TIMEOUT`.

## 3. Poprawka

| Zmiana | Plik |
|---|---|
| Jedna definicja źródeł przebiegu Findera: `finderPortalSources(filter)` = aktywne źródła **bez OLX**. OLX zostaje w `search_filters.sources`, bo czyta je oddzielny harmonogram. | `finder-portal-sources.ts` (nowy) |
| Start, przebieg, wznowienie i kontynuacja (`startFinderScanForFilter`, `runManualOtodomScan`, `runFinderScanPortion`) używają tylko portali. Usunięte: zlecanie i odczyt starej kolejki OLX, ostrzeżenia `OLX_PREVIOUS_JOB_IN_QUEUE`, `OLX_MULTIPLE_RUN_IDS`, `OLX_QUEUE_READ_FAILED`, `OLX_ENQUEUE_FAILED` oraz opcje `olxMode` i `olxNote`. Filtr z samym OLX: `409` z jasnym komunikatem, bez zadania. | `manual-scan.ts` |
| Harmonogram 5 h: faza OLX (`enqueue_scheduled_finder_olx_job`) bez zmian, uruchamiana jak dotąd przed portalami. Jej decyzja trafia tylko do `summary.olx`, nie do ostrzeżeń przebiegu portali. Blokada i warunek uruchomienia z `finderPortalSources`. | `finder-scheduler.ts` |
| „Ostatni przebieg” filtra pomija wiersze `olx` (oraz `facebook`). Przebieg OLX z harmonogramu ma własny `scan_run_id` i nie może zostać uznany za ostatni skan portali. | `latest-finder-run.ts` |
| `olxScheduleNote` zostaje jako opis decyzji harmonogramu (diagnostyka), już nie w przebiegu portali. | `finder-olx-schedule.ts` |

### Bez zmian
- Przetwarzanie ofert OLX (`olx-jobs.ts`: `completeOlxJob`, wspólny potok zapisu i dopasowania). Oferty z automatu OLX nadal trafiają do wyników Findera.
- Harmonogram OLX: 08:00, co 24 h, 1 na 24 h, budżet Browser Run, STOP, claim i koordynacja (SQL nietknięty, brak migracji).
- Dane historyczne: stare przebiegi z wierszem lub zadaniem OLX nadal pokazują blok OLX w postępie i wynikach. Nic nie jest przepisywane.
- Watchdog `OLX_WORKER_CLAIM_TIMEOUT` zostaje dla zadań nieautomatycznych w istniejących przebiegach. Nowe przebiegi Findera nie tworzą już takich zadań.
- Facebook Watcher i Radar cen.

## 4. Testy regresyjne

| Plik | Zakres |
|---|---|
| `manual-scan-lock-separation.test.ts` | start ręczny i z harmonogramu rezerwuje tylko portale i nie dotyka kolejki OLX (żadne wywołanie `olx-jobs`); przypadek `02e88883` / `bb495d7a`: historyczny wiersz OLX nietknięty; wznowienie przebiegu z historycznym wierszem OLX `pending` kończy portale bez czekania na OLX; równoległe kliknięcia: jeden przebieg, zero OLX; uszkodzona kolejka OLX (`OLX_MULTIPLE_RUN_IDS`, `OLX_QUEUE_READ_FAILED`) bez wpływu; filtr z samym OLX: `409`, brak zadania |
| `finder-olx-schedule.test.ts` | 72 h tików: portale co 300 min, OLX 1/24 h jak dotąd; `runScan` nie dostaje kontekstu OLX; decyzje OLX tylko w `summary.olx`; awaria OLX nie zatrzymuje portali i nie daje ostrzeżenia w ich przebiegu |
| `finder-run-observation.test.ts` | nowszy przebieg OLX z harmonogramu (przypadek 14.10) nie jest „ostatnim przebiegiem” portali; sama historia OLX ⇒ brak przebiegu Findera |
