# Naprawa Findera i optymalizacja Supabase — 13.10.2026

Zakres: widoczność dopasowań, eliminacja kamienic, lekki odczyt wyników, bezpieczna retencja danych operacyjnych.
Production nie był odpytywany ani modyfikowany. Żadna migracja nie została zastosowana.

## 1. Dlaczego zapisane dopasowania były niewidoczne

Odczyt (`getFilterResults`) ponownie ocenia każde powiązanie i dopiero wtedy decyduje o sekcji. Na tej drodze były cztery mechanizmy, które ukrywały aktywne, aktualnie dopasowane oferty:

| # | Mechanizm | Skutek |
|---|-----------|--------|
| A | Twarde okno 30 dni (`isWithinFinderPublicationWindow`) | 3 z 4 dopasowań (Dąbrowa 10.09, Teofilów 28.07 i 29.05) trafiały poza „Dopasowane”, widoczne tylko w historii. |
| B | Data publikacji = **najwcześniejsza** data ze wszystkich snapshotów | Ogłoszenie „odświeżone” na portalu (np. OLX pokazuje 01.10) ma w starszym snapshocie wcześniejszą datę pierwszej publikacji; wtedy także świeża oferta wypadała przez okno 30 dni. |
| C | Deduplikacja wybierała reprezentanta tylko wg „jakości” (URL, zdjęcie, świeżość) | Gdy to samo ogłoszenie było zapisane dwa razy (kopia MATCHED + nowsza kopia REVIEW ze zdjęciem), przegrywała kopia MATCHED. Grupa międzyportalowa z jednym członkiem REVIEW była w całości degradowana do REVIEW, a z członkiem REJECTED — znikała. |
| D | Reguła konfliktu typu budynku | Opis z dzielnicy Śródmieście w rodzaju „okolica pełna kamienic”, „w otoczeniu kamienic” był traktowany jak twierdzenie, że lokal jest w kamienicy. Przy `building_type=blok` dawało to `building_type_conflict` → odrzucenie przy odczycie, bez żadnego śladu w UI (powiązanie nadal `is_current_match=true`). |
| E | Ręczna akceptacja operatora (`manual_accept`) | Była ponownie oceniana jako REVIEW, więc zaakceptowana oferta nigdy nie trafiała do „Dopasowane”. |

**Oferta 269 000 zł (Śródmieście, 47,19 m², opublikowana 01.10.2026) — przyczyna potwierdzona w kontroli końcowej.** Odczyt Production z 11.10.2026 22:11, zapisany w repozytorium jako fixture testu i w opisie commitu `29af8c5`, pokazuje, że API zwracało tę ofertę w `results` jako MATCHED. Okno 30 dni jej nie dotyczyło, a typ budynku był potwierdzony. Mechanizmy A–D nie mogły jej więc ukryć.

Ukrywał ją interfejs: do commitu `f453b99` (12.10.2026 18:27) siatka kart „AKTYWNE / DOPASOWANE” była renderowana **za całą sekcją „Do oceny”** (83–87 kart). Operator widział nagłówek z licznikiem 1, a sama karta lądowała na samym dole strony. Jeśli Production działa na wersji sprzed `f453b99` albo PWA trzyma starą wersję, problem nadal występuje.

Ta gałąź zachowuje poprawną kolejność, co sprawdza test Playwright. Dodatkowo:
* „Do oceny” zawiera teraz tylko oferty z potwierdzonym typem budynku (10 zamiast 87);
* 77 ofert bez potwierdzonego typu jest w zwiniętej sekcji „Do weryfikacji budynku”.

Mechanizmy B–E zostały naprawione profilaktycznie, bo mogą ukryć inne oferty. Zapytania 2 i 3 w `supabase/verification/finder-visibility-diagnostics.sql` pozwalają to potwierdzić na danych (tylko odczyt).

Niezależnie od przyczyny obowiązuje teraz warunek akceptacji: każde bieżące powiązanie (aktualne dopasowanie lub jawne REVIEW) trafia **dokładnie raz** do jednej sekcji albo na listę „Zapisane dopasowania niewidoczne w wynikach” z czytelnym powodem.

## 2. Dlaczego niepotwierdzone typy budynku trafiały do Findera

* Brak typu budynku był zwykłym polem „nieznanym” — oferta lądowała w „Do oceny” razem z ofertami, którym brakuje np. liczby pokoi (77 z 87 ofert REVIEW).
* Ekstrakcja z opisu miała luki: „w apartamentowcu” (odmiana) nie było rozpoznawane, a „blokada” było rozpoznawane jako „blok”.
* Facebook Watcher miał własne, odmienne reguły: każde wystąpienie „kamienic…” (także „obok kamienicy”) było kamienicą, a „nowoczesny budynek”/„nowa inwestycja” — apartamentowcem (zgadywanie).
* Alerty push `canonical_match` sprawdzały tylko `lifecycle_status=ACTIVE`, bez typu budynku.

## 3. Zmiany w kodzie

**Widoczność**
* `publication-date.ts` — wiek oferty to informacja: `listingFreshness()` (wiek, „starsza oferta > 30 dni”, „aktualność niepotwierdzona” > 3 dni od ostatniego skanu), filtr wieku po stronie klienta, osobno pierwsza publikacja i ostatnie odświeżenie.
* `finder-sections.ts` (nowy) — podział na sekcje z deduplikacją preferującą lepszą sekcję, grupowaniem „MATCHED wygrywa”, wykluczeniem całej grupy przy kamienicy/odrzuceniu ręcznym oraz listą wykluczeń z powodami.
* `filter-results.ts` — honorowanie `manual_accept`, jawne powody wykluczeń (zarchiwizowana, nieaktualna, usunięta, odrzucona, konflikt źródła, brak ceny, duplikat, reguła filtra).
* API zwraca prawdziwy błąd (`detail`, kod, `Server-Timing`); UI pokazuje błąd z przyciskiem „Spróbuj ponownie” i zachowuje ostatnie dane zamiast pustego Findera; limit 30 s.

**Kamienice i typ budynku**
* `building-type-qualification.ts` (nowy) — jedna reguła dla wszystkich źródeł i odczytu: potwierdzony dozwolony / odrzucony / do weryfikacji. Potwierdzenie operatora ma pierwszeństwo.
* `listing-attribute-extraction.ts` — odmiany „apartamentowiec/wieżowiec”, „z wielkiej płyty”; poprawne słowo „blok”; sąsiedztwo („obok”, „wśród”, „przy starej kamienicy”, „ul. Kamienica”) i liczba mnoga („okolica pełna kamienic”) nie są dowodem; „w bloku obok kamienicy” opisuje blok.
* Nowa sekcja „Do weryfikacji budynku” z przyciskami Blok / Apartamentowiec / Kamienica / Dom (`POST /api/flip-finder/listings/[id]/building-type`, tabela `finder_building_type_confirmations`):
  * dostęp tylko dla operatora; klient serwisowy powstaje dopiero po autoryzacji;
  * walidacja UUID oraz listy dozwolonych typów;
  * operator jest zapisywany z sesji, nie z treści żądania.

  Historyczne oferty są ponownie kwalifikowane przy odczycie, bez usuwania danych.
* Sprzeczność między portalami (ta sama nieruchomość, inny portal podaje „kamienica”):
  * oferta trafia do „Do weryfikacji budynku”, zamiast znikać;
  * potwierdzenie bloku przez operatora przywraca ją do „Dopasowane”;
  * ręczne odrzucenie albo potwierdzona przez operatora kamienica wyklucza wszystkie kopie.
* Facebook Watcher (`facebook-apartment-safety.ts`) używa wspólnych reguł.
* Alerty/push: brak alertów dla potwierdzonej kamienicy/domu; `canonical_match` wymaga potwierdzonego bloku/apartamentowca.

**Wydajność odczytu**
* Aktywny widok pobiera tylko bieżące dopasowania i REVIEW (`.or(...)` po stronie PostgREST, z bezpiecznym powrotem do pełnego odczytu przy błędzie składni).
* Archiwum: osobne żądanie dopiero po otwarciu, paginacja po stronie serwera (30 na stronę, maks. 100).
* Skany: 60 najnowszych zamiast wszystkich; z `filter_snapshot` tylko `_scanProgress`.
* Snapshoty: tylko pola daty publikacji (`raw_data->>…`) zamiast pełnego JSON.
* Porównania rynkowe: bez opisów, cache 5 min w instancji; memoizacja `normalize()` w ARV.
* Grupowanie tożsamości: porównuje tylko pary o wspólnym kluczu (z O(n²) do ~liniowego).
* Dashboard: liczniki przez `count=exact, head=true` zamiast pobierania wszystkich powiązań i ofert (poprzednio ucinane po cichu na 1000 wierszach); liczenie kart w trybie `summaryOnly`; błąd jednego filtra nie zeruje dashboardu.
* Indeksy: nie dodano — istniejący `listing_filter_matches_filter_current_last_matched_idx` pokrywa prefiks `(search_filter_id, is_current_match)`; zapytanie 6 w pliku diagnostycznym pozwala to zweryfikować `EXPLAIN ANALYZE`.

## 4. Wyniki testów

| Zakres | Wynik |
|--------|-------|
| TypeScript (`tsc --noEmit`) | 0 błędów |
| ESLint (zmienione obszary) | 0 błędów (5 starszych ostrzeżeń poza zmianami) |
| Testy jednostkowe/integracyjne całego repo | 2553 testy; 43 niepowodzenia **identyczne jak na `main`** (worker Facebooka, rozszerzenie, klasyfikacja tras Radaru Cen) — zero nowych |
| Testy Findera/Watchera/alertów/kolektora | wszystkie przechodzą |
| Retencja na prawdziwym PostgreSQL (PGlite) | 5/5 |
| Bezpieczeństwo migracji i API potwierdzania typu | 5/5 |
| `next build` (produkcyjny, webpack) | OK |
| Playwright (Finder/Watcher) | nowy test naprawy OK; istniejące OK poza krokiem otwarcia popupu `facebook.com` w teście ramki karty — Chromium w sandboksie nie ma dostępu do internetu (`chrome-error://`), test kart i archiwum przechodzi |

Nowe testy regresyjne: kamienica nigdy w „Dopasowane”; nieznany typ → osobna kolejka; potwierdzony blok wraca do wyników; oferta > 30 dni nie znika; każde zapisane dopasowanie dokładnie raz; brak duplikatów; archiwum dopiero po otwarciu i stronicowane; 5 000 i 50 000 rekordów historycznych; rozmiar odpowiedzi < 1 MB; retencja nie dotyka historii cen ani aktywnych zadań; równoległe skany bez utraty i podwójnej kwalifikacji; prawdziwy błąd API w UI.

## 5–6. Wydajność i liczba zapytań — przed / po

Pomiar: `features/flip-finder/server/finder-read.benchmark.ts` uruchomiony na kodzie z `main` i z tej gałęzi, na danych w kształcie Production (3854 powiązania: 4 + 87 + 3763, 6007 skanów, 500 porównań), z symulowanym łączem do Supabase: 40 ms na zapytanie + 40 Mbit/s.

| Operacja | Przed | Po |
|----------|-------|----|
| Wyniki Findera (aktywny widok) | 1583 ms, 11 zapytań, **5719 wierszy**, 4,1 MB z bazy | **~340 ms**, 9 zapytań, **516 wierszy**, 0,4 MB |
| Dashboard (lista filtrów) | 1787 ms, 19 zapytań, 10 974 wiersze, 5,1 MB | **~390 ms**, 17 zapytań (głównie HEAD), 644 wiersze, 0,45 MB |
| Archiwum (otwarcie) | 40 s, 49 zapytań, 20 771 wierszy, 40 MB z bazy, **14,8 MB odpowiedzi** | **142 ms**, 8 zapytań, 211 wierszy, 134 KB na stronę |
| CPU odczytu (bez sieci) | ~650–760 ms | ~225 ms |
| Powiązania pobierane przy otwarciu | 3854 (×2: dashboard + wyniki) | 91 (×2) |

Realistycznie zwykłe otwarcie Findera (dashboard + wyniki równolegle) powinno mieścić się w ~1 s przy ciepłej funkcji Vercel; zimny start funkcji może dodać 1–2 s. Rzeczywisty czas jest widoczny w nagłówku `Server-Timing` oraz w sekcji „Źródła i historia skanów” (czas odczytu, liczba zapytań i powiązań).

## 7. Przewidywany odzysk miejsca (szacunek — dokładne liczby daje `finder_retention_report()`)

| Tabela | Rozmiar | Polityka | Szacowany odzysk |
|--------|---------|----------|------------------|
| `collector_scan_batches` | 51 MB | `payload` kompaktowany 14 dni po zakończeniu; wiersz usuwany po 90 dniach (statystyki dzienne zostają) | ~35–43 MB (dane JSON starsze niż 7–14 dni) |
| `source_scans` | 22 MB | skany zakończone > 30 dni: JSON diagnostyczny kompaktowany; wiersz usuwany, jeśli nic go nie wskazuje i nie jest najnowszym skanem filtra/źródła | ~10–15 MB |
| `gallery_request_traces` | 14 MB | 14 dni | ~9–12 MB |
| `facebook_worker_nonces` | 13 MB | 1 h po wygaśnięciu | ~13 MB (wszystkie 74 034 wygasłe) |
| `olx_worker_nonces`, `collector_request_nonces` | małe | 1 h po wygaśnięciu | niewielki |
| `listings`, `listing_snapshots`, `listing_filter_match_audit` | 12 / 10 / 5,2 MB | **bez zmian** | 0 |

Razem ok. 65–80 MB z ~176 MB. `DELETE`/`UPDATE` zwalnia miejsce do ponownego użycia po (auto)vacuum; zmniejszenie plików na dysku wymaga `VACUUM FULL` (blokada wyłączna) — nie jest uruchamiane automatycznie.

Przyczyna narastania nonce: `service_role` ma na `facebook_worker_nonces` tylko `INSERT, DELETE`, a `DELETE … WHERE expires_at < now()` wymaga też `SELECT` na `expires_at`. Czyszczenie wykonywane przy każdym żądaniu workera kończyło się „permission denied”, a błąd był ignorowany. Potwierdzone na PostgreSQL w teście; plik `supabase/drafts/retention/02_fix_facebook_worker_nonce_cleanup_grant.sql` (etap retencji) nadaje uprawnienie kolumnowe, a kod loguje błąd czyszczenia.

## 8. Jaką historię zachowujemy

* **Bezterminowo**: oferty, wszystkie snapshoty (historia cen i zmian), daty pierwszego i ostatniego wystąpienia, decyzje ręczne, powiązania z filtrami i ich audyt, metadane źródeł (dowody pochodzenia), analizy inwestycyjne, porównania rynkowe, CRM/Deal Room, Radar Cen.
* **Skany**: pełne szczegóły 30 dni; dłużej — wiersze wskazywane przez powiązania (pochodzenie dopasowania) i najnowszy skan każdego filtra/źródła (bez ciężkiego JSON); reszta jako statystyki dzienne (`finder_scan_daily_stats`).
* **Paczki kolektora**: pełny `payload` 14 dni, metadane 90 dni, potem statystyki dzienne (`finder_collector_batch_daily_stats`).
* **Ślady galerii**: 14 dni. **Nonce**: do godziny po wygaśnięciu.

## 9. Migracje i kolejność wdrożenia

**Niezbędna przed wdrożeniem Findera jest tylko jedna migracja:** `supabase/migrations/20261013120000_add_finder_building_type_confirmations.sql`.
* Tworzy jedną nową tabelę: RLS włączone, `authenticated` ma tylko SELECT, zapis wyłącznie przez service role.
* Nie zmienia istniejących danych.
* Bez niej Finder działa poprawnie, tylko przyciski potwierdzania typu budynku są wyłączone z komunikatem.

**Retencja to osobny etap:** `supabase/drafts/retention/` (poza `supabase/migrations`, więc `supabase db push` ani integracja Git jej nie zastosują), z instrukcją w `README.md`. Grant dla nonce także należy do tego etapu, bo po jego nadaniu aplikacja zacznie usuwać wygasłe nonce na Production.

**Nienaruszone:** historia cen (`listing_snapshots`), decyzje operatora (`manual_decision`, decyzje tożsamości), analizy inwestycyjne, Radar Cen i CRM. Wdrożenie nie zawiera żadnego DELETE, UPDATE danych, VACUUM ani harmonogramu.

Kolejność bezpiecznego wdrożenia:
1. Akceptacja PR #4.
2. Zastosowanie w Supabase (SQL editor) wyłącznie `20261013120000_add_finder_building_type_confirmations.sql`.
   * Kontrola: `select has_table_privilege('anon','public.finder_building_type_confirmations','SELECT');` → `false`.
3. Merge PR #4 do `main` i wdrożenie na Vercel.
4. Wymuszenie odświeżenia PWA na telefonie (kontrolka wersji), bo stara wersja trzymała kartę pod „Do oceny”.
5. Kontrola po wdrożeniu:
   * filtr „Flip” pokazuje 4 karty w „Dopasowane” (lub wpis z powodem na liście wykluczonych);
   * „Do oceny” ok. 10, „Do weryfikacji budynku” ok. 77;
   * nagłówek `Server-Timing` i panel „Źródła i historia skanów” pokazują czas odczytu i liczbę zapytań.
6. Uruchomienie zapytań z `finder-visibility-diagnostics.sql` (tylko odczyt) dla oferty 269 000 zł.
7. Osobno, po zgodzie: etap retencji z `supabase/drafts/retention/README.md`.

## 10. Konflikty z PR #2 (Radar Cen) i PR #3 (OLX Cloud Worker)

* **Konflikty tekstowe:** brak. Żaden plik nie jest wspólny, a `git merge-tree` scala PR #4+#2+#3 bez konfliktów.
* **Migracje:** PR #2 i #3 nie dodają migracji, więc nie ma kolizji numeracji.
* **Testy po scaleniu:** na połączonym drzewie PR #4+#2+#3 jest 2579 testów i 43 niepowodzenia — te same co na `main` i w samym PR #2.
* **TypeScript po scaleniu:** 4 błędy w `workers/olx-browser/src/worker.test.ts` występują już w samym PR #3. Nie wynikają ze scalenia i nie są zmieniane w tym PR.
* **Wpływ pośredni na Radar:** Radar (PR #2, `external-source-adapters.ts`) korzysta ze wspólnej funkcji `resolveBuildingType`. Po tym PR Radar:
  * rozpoznaje „apartamentowcu/apartment/wieżowiec”;
  * traktuje loft i plombę jako niedozwolone typy;
  * nie uznaje „wśród kamienic” za kamienicę.

  To zmiana zachowania na korzyść poprawności, bez zmian w kodzie Radaru. Testy Radaru przechodzą.
* **Worker OLX (PR #3):** używa istniejącego API `/api/olx-worker/*` i kolejki `olx_scan_jobs`, których ten PR nie zmienia. Przyszła retencja chroni zadania `queued/running` i ich skany.
