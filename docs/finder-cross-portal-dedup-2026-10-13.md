# Flip Finder — deduplikacja międzyportalowa (2026-10-13)

## Problem
Te same mieszkania z różnych portali były pokazywane jako osobne karty w „Dopasowane” i „Do oceny”
(np. 238 000 zł / 37,07 m² — OLX, Otodom, Gratka, Nieruchomości-online; 298 000 zł / 46,55 m² — OLX, Domy.pl, Oferty.net).
Grupowanie łączyło oferty tylko po jawnej tożsamości (ID portalu, numer oferty biura, numer lokalu), a portale tych danych zwykle nie podają.

## Rozwiązanie
`features/flip-finder/cross-portal-identity.ts` — ocena pary ofert z różnych portali na podstawie niezależnych dowodów:

| Dowód | Waga |
| --- | --- |
| numer oferty biura w treści | 6 |
| podobny opis (wspólne trójki słów) | 3 |
| te same zdjęcia (host + ścieżka) | 3 |
| identyczny / zgodny metraż | 2 / 1 |
| ulica | 2 |
| piętro | 1,5 |
| pokoje, numer budynku, dzielnica, tytuł, cena równa | 1 (cena bliska 0,5) |

- **Połączenie automatyczne** tylko gdy: różne portale, zgodne pokoje i metraż, co najmniej jeden silny dowód
  (opis, zdjęcia, numer oferty lub ulica), suma ≥ 7 i dowody lokalizacyjno-treściowe ≥ 3,5.
  Sama cena i metraż dają co najwyżej 3 pkt — nigdy nie łączą.
- **Twarde konflikty** (zawsze osobno): inny metraż, liczba pokoi, piętro, miasto, ulica, numer budynku lub lokalu,
  dzielnica Łodzi najwyższego poziomu, różnica ceny > 25%, ten sam portal.
- **Kandydat** (suma ≥ 4 bez konfliktu, ale za mało do połączenia) → sekcja „Możliwy duplikat” z listą zgodnych danych
  i przyciskami Połącz / Nie łącz (istniejące decyzje operatora).
- Decyzja „Nie łącz” i ręczne grupy operatora mają pierwszeństwo nad oceną automatyczną.
- Grupa jest MATCHED, jeśli którakolwiek kopia jest MATCHED — pozostałe kopie nie tworzą kart REVIEW.
- Czyszczenie wyników archiwizuje wszystkie połączone kopie karty (inaczej wracałyby jako osobna karta).

Grupowanie jest projekcją odczytu: rekordy ofert, zdjęcia, historia cen i decyzje operatora pozostają nienaruszone;
brak migracji i zmian w Supabase.

## Testy
- `features/flip-finder/cross-portal-identity.test.ts` — oba przypadki z Production, ochrona przed błędnym scaleniem
  (inne piętro/ulica/budynek/lokal/dzielnica/pokoje/metraż/cena, ten sam portal, brak łańcuchowania).
- `features/flip-finder/server/filter-results-cross-portal.test.ts` — pełna ścieżka odczytu Findera, decyzja „Nie łącz”,
  czyszczenie wyników.

## Weryfikacja na danych z Production (poprawki po przeglądzie)

Fakty z Production (13.10): Otodom (238 000 zł) ma pusty opis, Domy.pl (298 000 zł) 56 znaków, Oferty.net 91 znaków.
Dowód „podobny opis” wymaga ≥ 12 trójek słów po obu stronach, więc tych kopii opis nie potwierdza. Progi automatycznego
łączenia nie zostały obniżone: bez wspólnych zdjęć, numeru oferty lub ulicy takie kopie są pokazywane jako
„Możliwy duplikat” do ręcznej decyzji (Połącz / Nie łącz).

Zmiany:
- Para z identycznym metrażem (co do 0,01 m²) i tą samą lub bliską ceną, bez konfliktów, zawsze trafia co najmniej
  do „Możliwy duplikat” — także przy nieznanej liczbie pokoi.
- Parser pięter rozpoznaje `floor_3`, `FLOOR_4`, `ground_floor`, `FOURTH`, `GROUND`, rzymskie `IV` / „IV piętro” /
  „na IV piętrze” / „piętro: IV” oraz liczebniki („na czwartym piętrze”). „4-piętrowy blok”, „i piętro wyżej” nie są piętrem.
- Czyszczenie wyników z zakresem portalu (`source`) odmawia ukrycia kopii z innych portali bez potwierdzenia
  `includeLinkedCopies` i podaje listę portali. Odpowiedź zawiera `bySource` i `linkedCopiesFromOtherSources`.
- Ostrzeżenie „Wyczyść historię wyszukiwania” mówi wprost, że trwale usuwa wszystkie oferty ze wszystkich filtrów
  i portali (działanie tego przycisku nie zostało zmienione — było tak już na main).

## Diagnostyka READ-ONLY

`scripts/finder-dedup-diagnostics.mts` uruchamia dokładnie ścieżkę odczytu Findera (`getFilterResults`) dwa razy:
tylko z jawną tożsamością (karty „przed”) i z deduplikacją międzyportalową („po”). Raport zawiera liczbę kart, połączone
oferty, oferty osobno z powodem, punktację, dowody i konflikty każdej pary oraz ryzyko błędnego połączenia.
Klient Supabase jest opakowany przez `readOnlySupabase()` — insert/update/upsert/delete/rpc/storage rzucają błąd
przed wysłaniem zapytania.

```bash
# live, tylko SELECT (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY w środowisku)
node --import ./scripts/test-alias-loader.mjs --experimental-strip-types --experimental-test-module-mocks \
  scripts/finder-dedup-diagnostics.mts --filter <search_filter_id> --operator <user_id> \
  --case 238000:37.07 --case 298000:46.55 \
  --out finder-dedup-report.md \
  --export features/flip-finder/server/__fixtures__/finder-dedup-production.json
```

`--export` zapisuje dokładnie te wiersze, które Finder odczytał dla ofert z obu przypadków (i innych ofert o tej samej
cenie i metrażu). Test `filter-results-production-replay.test.ts` odtwarza je przez tę samą ścieżkę odczytu; do czasu
dodania eksportu jest pomijany z komunikatem. Po ręcznym sprawdzeniu ofert można wpisać w pliku `expected.groups`
oczekiwane grupy — test zacznie je egzekwować.
