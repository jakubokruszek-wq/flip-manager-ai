# Koordynacja odbioru zadań OLX, semantyka STOP i stary przebieg Radaru (audyt PR #16)

Stan: **kod i testy gotowe, nic nie wdrożono.** Migracja `20261017120000_coordinate_olx_claims.sql` to szkic do ręcznego zastosowania po osobnej zgodzie.

## 1. Znaleziony problem

Na Production działają trzy funkcje odbioru zadań OLX:

| Funkcja | Kto woła | Przed poprawką |
|---|---|---|
| `claim_olx_scan_job` | zwykły worker (lokalny, skany ręczne) | bez blokady wspólnej z nowym Workerem; brał **najstarsze** zadanie, także automatyczne (`requested_by = 'scheduler'`); odzysk lease wracał do kolejki **każde** wygasłe zadanie, także automatyczne |
| `claim_olx_scan_job_selective` | test stage2 (jedno wskazane zadanie) | bez wspólnej blokady; mógł wziąć wskazane zadanie automatyczne |
| `claim_scheduled_finder_olx_job` (PR #16) | Worker `scheduled` | własna blokada doradcza i sprawdzenie „brak żywego lease” |

Skutki (potwierdzone testem na prawdziwym PostgreSQL, wariant kontrolny bez poprawki):

1. **Równoczesny odbiór.** Stary claim w otwartej transakcji bierze zadanie ręczne. Nowy claim w tej samej chwili nie widzi niezatwierdzonego wiersza i bierze zadanie automatyczne. Efekt: dwie przeglądarki naraz.
2. **Przejęcie zadania automatycznego przez zwykły worker.** Omija STOP, limit 1–2/24 h i budżet przeglądarki.
3. **Nieautoryzowane ponowienie.** Zwykły claim przywraca do kolejki zadanie automatyczne z wygasłym lease i sam je bierze (`attempts = 2`).
4. **Spóźniony heartbeat.** Mógł „wskrzesić” wygasły lease zadania automatycznego, gdy inne zadanie już trwało.

## 2. Poprawka (migracja `20261017120000`)

| Zasada | Jak |
|---|---|
| Jedna blokada | Wszystkie trzy funkcje biorą tę samą blokadę transakcyjną (`pg_advisory_xact_lock`, klucz `finder-olx-scheduled-claim`), zanim cokolwiek odczytają. Kolejny claim czeka i decyduje na stanie zatwierdzonym. |
| Zadania automatyczne tylko dla Workera `scheduled` | Zwykły i selektywny claim nigdy ich nie wybierają. Odzysk i wyczerpanie lease w zwykłym claimie ich nie dotykają; zamyka je `expire_stale_scheduled_finder_olx_jobs` z jawnym kodem. |
| Jeden tor przeglądarki dla starego i nowego Workera | Zwykły i selektywny claim nic nie wydają, gdy zadanie automatyczne ma żywy lease. Claim `scheduled` nic nie wydaje, gdy jakiekolwiek zadanie ma żywy lease (bez zmian). |
| Brak ponowień i wskrzeszeń | Trigger `olx_scan_jobs_guard_scheduled` na zadaniach automatycznych odrzuca: `attempts > 1` i powrót do `queued` (`OLX_SCHEDULED_JOB_NO_RETRY`) oraz przedłużenie wygasłego lease (`OLX_SCHEDULED_JOB_LEASE_EXPIRED`). Heartbeat Workera kończy się wtedy `OLX_JOB_LEASE_LOST`. |
| Skany ręczne bez zmian | Dwa zwykłe workery nadal dostają różne zadania, tylko po kolei pod blokadą. Odzysk wygasłych zadań ręcznych i późny heartbeat zadania ręcznego działają jak dotąd. Sygnatury funkcji są te same, więc działające workery nie potrzebują nowego kodu. |

### Wygasły lease zadania automatycznego (test SQL i test współbieżny)

1. Lease wygasa → zadanie zostaje `running` (`attempts = 1`). Zwykły claim nie zwraca go do kolejki ani go nie bierze. Claim `scheduled` też go nie weźmie (`attempts = 0` tylko dla nowych).
2. Spóźniony heartbeat → odrzucony (`OLX_SCHEDULED_JOB_LEASE_EXPIRED`).
3. Po 10 min → `failed`, `OLX_SCHEDULED_JOB_LEASE_EXPIRED`. Historia zostaje, nic się nie ponawia.
4. Zwykły worker nie jest blokowany martwym lease: może od razu wziąć zadanie ręczne.

## 3. STOP — bezpieczna semantyka

Dotąd przy wyłączonym automacie harmonogram dalej tworzył zadania. Każde z nich po 6 h kończyło jako `OLX_SCHEDULED_JOB_NOT_CLAIMED` i do tego czasu zajmowało wspólny budżet 24 h, blokując skany ręczne.

| Sytuacja | Teraz |
|---|---|
| Termin, gdy automat jest OFF | **Nie powstaje żadne zadanie.** Decyzja `skipped`, powód `AUTOMATION_DISABLED` (widoczny w UI i w ostrzeżeniu przebiegu); budżet nietknięty. |
| Włączenie w czasie tolerancji terminu (≤ 3 h) | Ten sam termin rusza z opóźnieniem, raz. |
| Termin minął przy OFF | Zapisany **raz** w `finder_olx_slots` jako `missed`, przyczyna `AUTOMATION_DISABLED`. Bez nadrabiania; następny termin planowo. |
| Zadanie automatyczne czekające w kolejce w chwili STOP | Najbliższy tik harmonogramu (≤ 5 min) zamyka je jako `failed`, `OLX_SCHEDULED_JOB_STOPPED`, razem z `source_scans`. Nie czeka 6 h. |
| Zadanie automatyczne już w rękach Workera | Kończy się normalnie (≤ ~4 min); nic nie jest przerywane w połowie. |
| Diagnostyka | `scripts/olx-cloud-scheduled.check.sql` krok 12: opuszczone terminy z powodu STOP (dziennie) i zadania wycofane przez STOP. Krok 7: każdy termin z przyczyną. |

## 4. Stary przebieg Radaru na Production

Stan zgłoszony: przebieg `13ac1f61-ee43-4b5a-af3e-b09b407138ed` ma status `running` z wygasłym lease, a zadanie OLX `09b4e9b6-eb7f-4a3d-97c3-ad63dd7d6f71` czeka w kolejce.

Test `features/price-radar/server/radar-legacy-olx-run.e2e.test.ts` odtwarza ten stan (te same identyfikatory) na prawdziwych migracjach i uruchamia **prawdziwy kod Radaru** (`collect.ts`). Podróbką są tylko pobierania z portali.

| Krok | Wynik |
|---|---|
| Stan dzisiejszy (kontrola) | Zwykły worker **wziąłby** `09b4e9b6`. |
| Migracje PR #16 | `09b4e9b6` → `failed`, `RADAR_OLX_REMOVED`, audyt `result_summary.radarOlxRemoved` (`retiredFromStatus: queued`). Nic nie usunięto, zadania nie uruchomiono. Przebieg nietknięty. |
| Automatyczna kontynuacja (`claim_price_radar_run` przejmuje wygasły lease) | Ten sam przebieg, bez drugiego. Etap OLX zamknięty jako `RADAR_OLX_REMOVED`, pozostały portal przechodzi, ukończony nie jest pobierany ponownie. Koniec: `partial`. Nie powstaje żadne zadanie OLX. |
| Wznowienie przez operatora (`resumeExistingRadarRun`) | Jak wyżej. Wznowienie nie czeka na OLX. |
| Kolejność merge → kontynuacja Radaru → migracja | Radar nie zleca OLX. Migracja i tak wycofuje zadanie. |
| Po migracji | Żaden z trzech claimów nie wyda `09b4e9b6`. |

**Wniosek operacyjny.** Między merge a migracjami lokalny worker OLX mógłby odebrać `09b4e9b6`. Dlatego migracje trzeba zastosować zaraz po merge, a lokalny worker OLX ma być na ten czas wyłączony.

## 5. Kolejność wdrożenia (każdy krok po osobnej zgodzie)

1. Wyłącz lokalny worker OLX na czas kroków 2–3.
2. Merge PR #16 → Vercel.
3. W jednym oknie SQL Editora, po kolei: `20261015120000`, `20261016120000`, `20261017120000`. Automat zostaje **OFF**.
4. Kontrola: `scripts/olx-cloud-scheduled.check.sql`:
   - krok 9: brak oczekujących zadań OLX Radaru;
   - krok 10: wszystkie kolumny `true` i trigger;
   - krok 11: brak nowych wierszy.
5. Włącz lokalny worker. Skany ręczne działają jak dotąd.
6. Dalej jak w [`olx-slot-schedule.md`](olx-slot-schedule.md) §4: Worker `scheduled` wdrożony wyłączony, potem `enable` z limitem 1.

**Uwaga.** Od migracji `20261016120000` automatyczne zadania OLX z harmonogramu PR #15 przestają powstawać przy wyłączonym automacie. Od migracji `20261017120000` zwykły worker ich nie bierze. Automatyczne OLX wraca dopiero po włączeniu Workera `scheduled`. Skany ręczne działają bez przerwy.

## 6. Rollback

Kolejność: STOP → `scripts/olx-claim-coordination.rollback.sql` → (opcjonalnie) `scripts/olx-slot-schedule.rollback.sql` → `scripts/olx-cloud-scheduled.rollback.sql`.

- Pierwszy skrypt przywraca bajt w bajt `claim_olx_scan_job` (20260810190000), `claim_olx_scan_job_selective` (20261013180000) i `expire_stale_scheduled_finder_olx_jobs` (20261015120000) oraz usuwa trigger.
- Test sprawdza, że po wszystkich trzech funkcje i triggery są identyczne jak na dzisiejszym Production, a historia zadań zostaje.
- Po samym pierwszym skrypcie zwykły claim znów bierze zadania automatyczne. Automat musi więc zostać OFF albo trzeba cofnąć także 20261016/20261015.

## 7. Testy

| Plik | Liczba | Zakres |
|---|---|---|
| `olx-claim-coordination.race.test.ts` (prawdziwy PostgreSQL, osobne połączenia psql) | 7 | kontrola bez poprawki (2 przeglądarki naraz, przejęcie i ponowienie zadania automatycznego); stary claim w toku → `scheduled` **czeka** na blokadzie (obserwowane w `pg_locks`) i odmawia; `scheduled` w toku → stary i selektywny czekają i nic nie wydają; selektywny w toku → `scheduled` czeka; dwa zwykłe workery nadal obsłużone; burza 9 połączeń × 15 rund (niezmienniki w każdej rundzie); wygasły lease + claimy + spóźniony heartbeat jednocześnie |
| `olx-claim-coordination.rpc.test.ts` (PGlite, pełny łańcuch migracji) | 11 | kto co bierze; żywy lease automatu blokuje stare claimy; wygasły lease bez ponowień i wskrzeszeń; zadania ręczne bez zmian; STOP: brak zadań, `missed` raz, włączenie w tolerancji, wycofanie kolejki `OLX_SCHEDULED_JOB_STOPPED`; rollback bajt w bajt i ponowne zastosowanie; pełny rollback do stanu Production; uprawnienia; skrypt kontrolny |
| `olx-slot-schedule.e2e.test.ts` | +1 (4) | doba STOP: każdy termin `missed AUTOMATION_DISABLED`, zero zadań `NOT_CLAIMED`, po włączeniu następny termin; całość z migracją 20261017 |
| `radar-legacy-olx-run.e2e.test.ts` (prawdziwy `collect.ts` na prawdziwym SQL) | 5 | przypadek `13ac1f61` / `09b4e9b6` (§4) |
| `finder-olx-schedule.test.ts`, `olx-scheduled-claim.test.ts` | aktualizacje | powód `AUTOMATION_DISABLED`, licznik `stopped` |

CI: workflow `olx-claim-coordination.yml` (PGlite + kontener `postgres:17`; test współbieżny jest wymagany, nie może się pominąć).
