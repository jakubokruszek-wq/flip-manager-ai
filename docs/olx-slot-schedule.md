# OLX o stałych godzinach (12/24/48/72 h), limit 2 zadań na 24 h w budżecie przeglądarki i OLX poza Radarem

Stan: **kod gotowy, nic nie wdrożono.**
- Migracja `20261016120000_olx_slot_schedule_and_radar_olx_removal.sql` jest szkicem.
- Limit automatycznych zadań zostaje **1 na 24 h**, dopóki operator go nie podniesie.
- Worker `scheduled` pozostaje wyłączony; stage2 pozostaje testowym Workerem `manual`, OFF.

Uzupełnia: [`finder-olx-schedule.md`](finder-olx-schedule.md) (PR #15), [`olx-cloud-scheduled.md`](olx-cloud-scheduled.md) (Worker `scheduled`) i [`radar-olx-removal.md`](radar-olx-removal.md).

## 1. Godzina startu i harmonogram w slotach

| Ustawienie | Wartość |
|---|---|
| Godzina startu OLX | `HH:mm`, co 5 minut (00:00–23:55), domyślnie **08:00**; `search_filters.finder_olx_start_time` |
| Strefa czasowa | **Europe/Warsaw**, czas ścienny |
| Interwał | **12, 24, 48 albo 72 h**; baza nie przyjmie innej wartości |
| Kotwica | `search_filters.finder_olx_schedule_anchor`: lokalny czas pierwszego terminu. Ustawia ją trigger przy zmianie godziny lub interwału na najbliższe wystąpienie godziny startu (dla 12 h: startu albo startu + 12 h). Zapis bezpośredni jest ignorowany. |

- **Terminy (sloty)** to `kotwica + k × interwał`, liczone na zegarze ściennym.
  - 12 h, 08:00 → codziennie 08:00 i 20:00;
  - 24 h → codziennie 08:00;
  - 48/72 h → co 2 albo 3 dni od daty kotwicy.
- **DST:** 08:00 zostaje 08:00, zarówno latem (06:00 UTC), jak i zimą (07:00 UTC). Testy obejmują 28.03.2027 i 25.10.2026.
- **Liczone od terminów, nie od zakończenia.** Spóźnione albo długie pobieranie niczego nie przesuwa; kolejny termin jest zawsze planowy.
- **Pozostałe portale** mają bez zmian `finder_scan_interval_minutes` (300 min). pg_cron nadal co 5 minut.

### Deduplikacja, restart, awaria

- Rozpatrywany jest **tylko bieżący termin**, w tolerancji `min(3 h, interwał / 2)`; dla 12 i 24 h to 3 h.
- **Każdy termin ma najwyżej jedno rozstrzygnięcie:** wiersz `finder_olx_slots` (klucz `filtr + slot_at`), do tego blokada doradcza i klucz idempotencji zadania `filtr:olx-slot:<epoch>`.
  - Równoległe wywołania (pg_cron + GitHub Actions, wiele instancji) dają jedno zadanie.
- **Po restarcie lub awarii nie ma lawiny:** starsze terminy nie są nadrabiane.
  - Bieżący termin w tolerancji uruchomi się z widocznym opóźnieniem.
  - Po tolerancji jest zapisany jako `missed` z przyczyną (np. `OLX_JOB_IN_FLIGHT`, `AUTOMATIC_DAILY_BUDGET_USED`) i czeka się na następny.
- **Zadanie nieodebrane przez Workera:** po 6 h `failed` z kodem `OLX_SCHEDULED_JOB_NOT_CLAIMED`. Historii się nie usuwa i nie ponawia.

### UI (ustawienia filtra → Harmonogram, gdy wybrany jest OLX)

Pola „Interwał OLX” i „Godzina startu OLX (czas polski)”. Pod nimi:
- ostatni termin: planowany i rzeczywisty start, opóźnienie, wynik zadania;
- następny termin;
- powód pominięcia z najbliższą możliwością;
- zadania OLX z ostatnich 24 h na tle limitów;
- budżet przeglądarki Cloudflare (dziś);
- status Workera: automat WŁĄCZONY/STOP, ostatnie zadanie, kod błędu, worker.

## 2. Interwał 12 h naprawdę działa: do 2 zadań na 24 h, bramkowane czasem przeglądarki

Dotąd 12 h nie mogło działać: PR #15 miał limit 1/24 h wpisany na stałe, a Worker — 1 zadanie na dobę.

| Element | Zmiana |
|---|---|
| Globalny limit automatyczny | `olx_automation_control.max_claims_24h` może mieć 0–2; **domyślnie 1**. Ta sama wartość obowiązuje przy zleceniu i przy odbiorze, łącznie dla wszystkich filtrów. |
| Ręczne skany Findera | Liczą się do wspólnego budżetu. Efektywny limit wspólny = `max(FINDER_OLX_SHARED_DAILY_JOB_BUDGET, limit automatyczny)`. Wycofane zadania Radaru się nie liczą. |
| Czas przeglądarki | Worker przy **każdym** claimie wysyła zużycie: Browser Run całego konta dziś (`history()`), własny ledger, bezpieczny budżet i **zmierzony koszt ostatniego zadania**. Baza zapisuje to w `olx_cloud_budget`. |
| Odmowa zlecenia z powodu budżetu | Termin, którego zadanie nie zmieści się dziś (UTC) w budżecie, jest pomijany jako `BROWSER_BUDGET_INSUFFICIENT`. Powód jest widoczny w UI i w ostrzeżeniu przebiegu. |
| Odmowa claimu | Brak lub niepoprawny raport → `BROWSER_USAGE_UNKNOWN`; za mało budżetu → `BROWSER_BUDGET_INSUFFICIENT`. Budżet zgłoszony powyżej 300 s jest przycinany do 300 s. |
| Worker `scheduled` | `OLX_CLOUD_MAX_JOBS_PER_DAY` może mieć 1 albo 2 (w pliku **2**). Bezpieczny budżet bez zmian: **120 s** z 600 s. Przed claimem warunek `max(konto, ledger) + koszt ostatniego zadania (min. 35 s) ≤ 120 s`. Koszt zadania jest mierzony i przechodzi przez północ UTC. |
| Stage2 | Bez zmian: `manual`, OFF, 1 zadanie na dobę; nie jest włączany. |

**Limity nie rosną same.** Drugie zadanie dnia ruszy dopiero, gdy operator ustawi `max_claims_24h = 2` po weryfikacji budżetu (§4).
- Nawet wtedy każde zadanie musi zmieścić się w zmierzonym budżecie przeglądarki.
- Przy limicie 1 drugi termin dnia dla 12 h jest pomijany z powodem `AUTOMATIC_DAILY_BUDGET_USED`.

## 3. OLX poza Radarem cen

Szczegóły: [`radar-olx-removal.md`](radar-olx-removal.md).
- Radar nie zleca, nie wznawia i nie liczy OLX: aplikacja wycina go ze źródeł i ustawień, a baza blokuje zadania OLX Radaru triggerem.
- Oczekujące stare zadania OLX Radaru są wycofywane z kodem `RADAR_OLX_REMOVED` i wpisem audytowym, bez uruchamiania.
- Historia ofert OLX zostaje w tabeli, ale nie trafia do bieżących próbek ani średnich.

## 4. Plan wdrożenia (każdy krok po osobnej zgodzie)

Wymaga wcześniej wdrożonych migracji `20261014120000` (PR #15, jest) i `20261015120000` (Worker `scheduled`).

1. **Merge → Vercel.** Przed migracją kod działa bez zmian:
   - harmonogram według PR #15;
   - zapis filtra pomija brakującą kolumnę godziny;
   - claim bez funkcji 3-argumentowej → 503 / brak zadania.
   - **Radar od razu przestaje zlecać OLX** (kod).
2. **Migracja `20261016120000`** (SQL Editor). Kontrola: `scripts/olx-cloud-scheduled.check.sql`, kroki 6–9:
   - kotwice i bieżące terminy;
   - brak oczekujących zadań OLX Radaru;
   - wycofane z audytem.
3. **Worker `scheduled`:** workflow `deploy-disabled`, potem `check` (`maxJobsPerDay = 2`, budżet 120 s, OFF).
4. **Weryfikacja budżetu, zanim limit wzrośnie do 2:**
   - przez kilka dni z limitem 1 sprawdź `olx_cloud_budget` (`job_estimate_ms`, `account_browser_ms`) oraz `/status` (`browserSecondsUsedToday`, `OLX_CLOUD_JOB_BROWSER_COST`);
   - 2 zadania muszą zmieścić się w 120 s razem z innym zużyciem konta (testy stage2), czyli koszt zadania ≲ 55 s.
5. **Dopiero wtedy:** `update public.olx_automation_control set max_claims_24h = 2;` i interwał 12 h w filtrze.
6. Obserwacja (kroki 6–8 skryptu kontroli):
   - terminy 08:00/20:00;
   - opóźnienie ≤ 15 min;
   - brak `BROWSER_BUDGET_INSUFFICIENT`.

## 5. Rollback

| Element | Wycofanie |
|---|---|
| Limit 2 | `update public.olx_automation_control set max_claims_24h = 1;` (natychmiast) |
| STOP automatu | `scripts/olx-cloud-scheduled.stop.sql` / workflow `disable` |
| Kod | revert PR (Radar wraca do starego kodu, ale baza dalej blokuje OLX Radaru, dopóki działa trigger) |
| Migracja | po STOP i revercie kodu: `scripts/olx-slot-schedule.rollback.sql`. Przywraca funkcję PR #15 1:1, filtry 12 h wracają do 24 h, usuwa sloty, raporty budżetu i trigger Radaru. Zadania i historia zostają; wycofane zadania OLX Radaru **pozostają** `failed` (świadomie). |

## 6. Testy

| Plik | Liczba | Zakres |
|---|---|---|
| `olx-slot-schedule.rpc.test.ts` (PGlite, prawdziwe migracje) | 14 | 12 h 08:00/20:00 przez oba DST; 24/48/72 h, koniec miesiąca, przed pierwszym terminem; pierwszy termin po zmianie; trwałość kotwicy; ograniczenia; jedno zadanie przy równoległych wywołaniach; spóźnione zakończenie nie przesuwa; awaria 3 dni → jeden `missed`, bez nadrabiania; restart w tolerancji; 12 h przy limicie 1 (powód) i 2; 3 filtry × 48 h ≤ 2/24 h z udziałem każdego; ręczne skany we wspólnym budżecie; budżet przeglądarki (`BROWSER_BUDGET_INSUFFICIENT`, raport z innego dnia); claim z raportem (nieznany, przekroczony, przycięcie 300 s, brak równoległych, 2/24 h); Radar: wycofanie z audytem, blokada insert, requeue → failed, zwykły claim nie bierze Radaru; rollback i ponowne zastosowanie |
| `olx-slot-schedule.e2e.test.ts` (prawdziwy scheduler + SQL + symulowany Worker) | 3 | 72 h co 5 min: zadania 08:00 i 20:00, odbiór ≤ 15 min, portale co 300 min; awaria Cloudflare przez dobę (`NOT_CLAIMED`, brak zaległości, powrót od następnego terminu); 2 filtry: ≤ 2 w każdym oknie 24 h |
| Worker `scheduled-mode.integration.test.ts` | +3 | 12 h: drugie zadanie przy limicie 2, trzecie nigdy, przy 1 odmowa; zmierzony koszt zadania → estymata → raport → blokada; odmowy bazy |
| Radar: `collect`, `collect-checkpoint`, `radar-run-resume`, `radar-olx-queue`, `radar-results`, `settings`, testy przeglądarkowe | nowe i zaktualizowane | brak OLX w źródłach i ustawieniach; stary przebieg z OLX `pending`/`running` → `RADAR_OLX_REMOVED`, inne portale kończą; resume nie czeka na OLX; `enqueueRadarOlxJob` odmawia przed dostępem do bazy; archiwalne OLX poza próbkami i średnimi |
| `search-filters-olx-interval.test.ts`, `finder-olx-schedule.test.ts`, `olx-scheduled-claim.test.ts`, trasa, formularz | aktualizacje | 12 h, godzina startu, odczyt `HH:mm:ss`, raport zużycia w claimie, nowe powody |
