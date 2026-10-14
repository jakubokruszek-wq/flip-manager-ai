# OLX usunięty z Radaru cen

OLX zostaje wyłącznie w Flip Finderze. Pozostałe źródła Radaru działają bez zmian.

## Ścieżki i zabezpieczenia

| Ścieżka | Zmiana |
|---|---|
| Lista źródeł (`RADAR_SOURCES`), UI, ustawienia, API wyników | `RADAR_REMOVED_SOURCES = {"olx"}`. OLX nie jest źródłem Radaru, więc serwerowa walidacja ustawień go odrzuca. Zapisane ustawienie „tylko OLX” oznacza wszystkie bieżące źródła. Brak przycisku OLX w UI. |
| Nowy przebieg (automatyczny, ręczny) | `claimOrCreateRadarRun` odrzuca OLX przed zasadą „brak wyboru = wszystkie”. Kolejka przebiegu nigdy nie zawiera OLX. |
| Porcja zbierania | `pickNextSource` nigdy nie wybiera OLX. Ścieżka kolejkowania OLX została zastąpiona zamknięciem etapu. |
| Stary przebieg z OLX w checkpoint (`pending`, `running`, po STOP) | Pierwsza porcja zamyka etap: `failed` + `RADAR_OLX_REMOVED: … (poprzedni status: …)`, kursor DONE. Inne portale kończą normalnie, a przebieg kończy się jako `partial` z jawną przyczyną. |
| Wznowienie (`resumeExistingRadarRun`) | Nie czeka już na zadanie OLX (`olx_queue_owns_source`) i niczego nie kolejkuje. Żywe stare zadanie traci lease Radaru i nie może zapisać przebiegu. |
| `enqueueRadarOlxJob` | Odmawia `RADAR_OLX_REMOVED` **przed** jakimkolwiek odczytem lub zapisem: nie da się ani utworzyć zadania, ani wznowić go po STOP. |
| Baza (migracja `20261016120000`) | Trigger `olx_scan_jobs_block_price_radar`: `INSERT` zadania `price_radar` kończy się wyjątkiem. Każde przejście do `queued` lub `running` (requeue w `claim_price_radar_run`, wznowienie STOP, claim workera, heartbeat) zamienia zadanie w `failed` z kodem `RADAR_OLX_REMOVED` i wpisem `result_summary.radarOlxRemoved`. |
| Istniejące zadania OLX Radaru | `queued` i `running` → `failed` z kodem `RADAR_OLX_REMOVED` i audytem (`retiredFromStatus`, poprzedni kod). Bez uruchamiania; nic nie jest usuwane. |
| Oferty OLX w `price_radar_listings` | Zostają (historia). `getRadarResults` pomija `source = 'olx'`, więc nie ma ich w bieżących ofertach, próbkach A/B ani średnich. |

## Kontrola po wdrożeniu (tylko odczyt)

`scripts/olx-cloud-scheduled.check.sql`, krok 9:
- brak zadań OLX Radaru w stanie `queued` lub `running`;
- liczba wycofanych z kodem `RADAR_OLX_REMOVED`.

## Rollback

Revert kodu przywraca stary kod Radaru. Baza nadal blokuje OLX Radaru, dopóki działa trigger. Usunięcie triggera wykonuje `scripts/olx-slot-schedule.rollback.sql`. Wycofanych zadań nie przywraca się do kolejki: to historia, a ich wznowienie uruchomiłoby OLX w Radarze.
