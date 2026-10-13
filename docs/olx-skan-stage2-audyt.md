# Audyt pierwszego skanu OLX z Cloudflare stage2

Przebieg: GitHub Actions 38460045910, zadanie Findera `4f33711a-de5c-4ccf-b7c0-5048fd73b511`.

Wynik:
- odczytano 52 oferty, w tym 49 unikalnych (`OLX_CLOUD_DUPLICATE_IDS`: 3 powtórzenia);
- 1 aktualne dopasowanie, 48 niedopasowanych;
- 4 nowe rekordy, 3 zaktualizowane, 3 spadki cen.

## Ścieżka i wnioski

| Etap | Kod | Ocena |
|---|---|---|
| Parser OLX | `features/flip-finder/olx-parser.ts` (w Workerze jako bundle) | poprawny; w trybie `legacy` ID = segment URL ze slugiem tytułu |
| Deduplikacja w paczce | `completeOlxJob` (`server/olx-jobs.ts`) | **brakowała**, liczniki liczyły powtórzenia, poprawione |
| Zapis | `persistListing` (`server/persist-listing.ts`) | upsert po `(source, external_listing_id)`, a potem po `normalized_url`; **zmiana tytułu tworzyła kopię**, poprawione |
| Ocena filtra | `evaluateListingAgainstFilter` | poprawna: kamienica i 19 m² → `REJECTED`, Teofilów → `MATCHED` |
| Sekcje Findera | `listing_filter_matches` + `finder-sections.ts` | bez zmian; rekordy odrzucone zostają danymi źródłowymi, nie są usuwane |

### 1. Trzy powtórzone identyfikatory

OLX pokazuje ogłoszenia promowane nad listą i ponownie na liście. To ten sam obiekt z tym samym `id`.

- **Baza:** kopii nie było. Drugie wystąpienie trafiało w ten sam wiersz (upsert po
  `source, external_listing_id`), bez zmian treści, więc `updated = 0` i nie powstawała nowa migawka.
- **Liczniki:** każde powtórzenie było oceniane i liczone ponownie (`matched_count`, `matchDiagnostics`).
  Powtórzona pasująca oferta dawała „2 dopasowania”.
- **Ryzyko:** gdyby kopie różniły się ceną, kolejność na stronie decydowałaby o zapisanej cenie,
  a w jednym skanie mógłby powstać fałszywy „spadek ceny”.
- **Poprawka:** `dedupeListingsByExternalId` przetwarza każdą ofertę raz i zachowuje pierwszą kopię
  ze strony. Ostrzeżenie `OLX_DUPLICATE_LISTINGS_MERGED` podaje liczbę powtórzeń, a osobno te z inną
  ceną lub treścią.

3 aktualizacje i 3 spadki cen w tym skanie to istniejące rekordy z niższą ceną, nie powtórzenia.
Pierwsze wystąpienie każdego ID jest przetwarzane tak samo jak wcześniej.

### 2. Stabilność ID po zmianie tytułu lub URL

W trybie `OLX_CLOUD_LISTING_ID_MODE="legacy"` (stage2 i worker lokalny) parser Findera używa `ad.id`
tylko wtedy, gdy jest tekstem. OLX podaje liczbę, więc ID to ostatni segment URL:
`najciekawsze-mieszkanie-na-teofilowie-CID3-IDTEOF1.html`.

Edycja tytułu zmienia slug, a więc **ID i `normalized_url` naraz**. `persistListing` nie znajdował
rekordu ani po ID, ani po URL i tworzył **drugi rekord tej samej oferty**.

**Poprawka (bez migracji, niezależna od trybu ID):**
- gdy ID i URL nic nie znalazły, `persistListing` szuka oferty OLX po tokenie `-ID<token>.html`
  (`olxUrlIdToken`), wybierając najnowszy rekord;
- token nie zależy od tytułu i zawiera tylko litery i cyfry, więc nie może zawierać znaków wieloznacznych LIKE;
- zachowane jest zapisane `external_listing_id`, więc dopasowania i Radar nadal wskazują ten sam rekord;
- rekord dostaje aktualny URL i tytuł, więc następny skan znajdzie go już po URL;
- dodatkowe zapytanie wykonuje się tylko dla ofert, których nie znaleziono po ID ani po URL
  (w tym skanie 4).

Tryb `stable_finder` (numeryczne `ad.id`) pozostaje osobną decyzją (§2 w `olx-worker-cloudflare.md`).
Konfiguracja stage2 jest bez zmian.

### 3. Statystyki skanu

Wynik zadania OLX (`result_summary.stats` oraz linia `OLX_SCAN_STATS` w `source_scans.warnings`)
podaje teraz osobno:

| Grupa | Pole | Znaczenie |
|---|---|---|
| Dane źródłowe | `read` | odczytane ze strony OLX |
| | `skippedInvalid` | pominięte przed zapisem (brak poprawnej ceny) |
| | `unique` | unikalne oferty zapisane jako dane źródłowe |
| | `duplicates` | powtórzenia ID na stronie, przetworzone raz |
| | `created` / `updated` / `unchanged` | nowe rekordy / zmieniona cena lub treść / bez zmian |
| Ocena filtra | `matched` | aktualne dopasowania (sekcja wyników) |
| | `review` | do weryfikacji (nieznane pola) |
| | `rejectedByFilter` | odrzucone przez obecny filtr; **zostają w bazie jako dane źródłowe** |

Niezmiennik: `matched + review + rejectedByFilter = unique`. Karta źródła w panelu diagnostycznym
Findera pokazuje obie grupy, gdy wynik zawiera `stats`.

Dla tego skanu oczekiwane wartości po poprawce:

| Odczytane | Unikalne | Powtórzenia | Nowe | Zaktualizowane | Bez zmian | Dopasowane | Do weryfikacji + odrzucone przez filtr |
|---|---|---|---|---|---|---|---|
| 52 | 49 | 3 | 4 | 3 | 42 | 1 | 48 |

### 4. Sekcje Findera

Sekcja aktualnych dopasowań zależy od `listing_filter_matches.is_current_match`, ustawianego przez
`reconcileCanonicalListingDecision` na podstawie `bucket` z oceny filtra:
- `REVIEW` trafia do weryfikacji;
- `REJECTED` nie trafia do wyników, ale rekord w `listings` zostaje.

Ta logika nie była zmieniana.

## Testy regresyjne

- `features/flip-finder/olx-scan-regression.test.ts`, na prawdziwym parserze Findera:
  - Teofilów (37,07 m², 2 pokoje, blok, 238 000 zł) → dopasowanie;
  - kamienica i kawalerka 19 m² → `REJECTED`;
  - 52 ogłoszenia z 3 powtórzeniami → 49 ofert i 1 dopasowanie;
  - powtórzenie z inną ceną → konflikt;
  - token `-ID` jest stabilny po zmianie tytułu;
  - walidacja tokenu.
- `features/flip-finder/server/persist-listing-olx-reprocess.test.ts`:
  - ponowne przetworzenie tej samej oferty → ten sam rekord, ani nowy, ani zaktualizowany;
  - spadek ceny → ten sam rekord, 1 spadek;
  - zmiana tytułu → ten sam rekord, zachowane ID i nowy URL;
  - nowa oferta → nowy rekord.

## Obserwacja z przebiegu (Cloudflare)

Po wdrożeniu wyłączonej wersji Durable Object jeszcze przez około 28 s raportował poprzednią, włączoną
wersję. W logu widać `zgodne=false reset=true` w próbach 1–5 i zgodność dopiero w próbie 6.
- Gdyby w tym czasie wywołano `/run-once` lub `/selftest`, odmówiłyby pracy (`OLX_CLOUD_RUNNER_VERSION_MISMATCH`).
- Tryb `manual` nie ma alarmu ani Cron.
- Workflow czekał na zgodność wersji, tak jak zaprojektowano w PR #12. Nic nie wymaga zmiany.
