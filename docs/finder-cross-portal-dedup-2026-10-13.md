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
