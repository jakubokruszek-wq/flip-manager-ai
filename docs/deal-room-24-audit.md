# Issue #24 — audyt Deal Room i zakres P0

Baza: main `642fdf3301d08cd0151526625bd05ced3bc2fd43`. Oddzielna gałąź
`feat/deal-room-qa`, worktree `/workspace/flip-deal-room`. PR #23, Android,
Render, OLX i produkcja nie są częścią tej zmiany. Audyt wyłącznie kodu oraz
syntetycznych fixture; bez odczytów lub zapisów produkcyjnego Supabase.

## Rzeczywisty przepływ i braki

Finder przekazuje listingId do InvestmentDesk. GET czyta utrwalony CanonicalDeal;
POST initialize pobiera ofertę, ostatni snapshot, ustawienia, zapisane korekty,
kompy i track record; buduje pięć kanonicznych wyników, zapisuje CAS i dodatkowe
projekcje historii. Brain tworzy z tego dziesięć deterministycznych projekcji.
Nie ma niezależnych agentów, nowych badań internetowych ani nowych kompetencji
prawnika/wykonawcy. Wyjaśnienia i kwoty nie wymagają płatnego AI.

| Dyrekcja | Wejścia i źródła | Wynik/gotowość/freshness | Braki i zależności |
|---|---|---|---|
| SCOUT | listings, identyfikator, URL, fakty źródłowe | kompletność i pochodzenie; fingerprint źródła | nie wyszukuje ponownie ofert; brak niezależnej inspekcji |
| VERIFY | SCOUT, canonical facts, konflikty ostatniego snapshotu | missing fields, konflikty, validation, observedAt | nie sprawdza KW; override sprzeczny ze źródłem nie usuwa konfliktu |
| MARKET | VERIFY, istniejące resale_comps i market_assumptions | low/base/high, liczba kompów, fallback, daty, confidence | ceny ofertowe nie stają się transakcyjnymi; brak niezależnej wyceny |
| RENOVATION | VERIFY, metraż, condition, underwriting | koszt z istniejącego silnika; freshness odziedziczona | brak podpisanego kosztorysu i osobnego wyniku wykonawcy |
| UNDERWRITER | VERIFY, MARKET, ustawienia, korekty | trzy scenariusze, koszt, profit/ROI, Max Buy; walidator granicy | założenia podatków i finansowania nie są potwierdzonymi faktami |
| RISK_LEGAL | VERIFY, bramki CEO, konflikty | lista ryzyk i brakujących dowodów | legalStatus jest obecnie zawsze false; brak procedury profesjonalnego zatwierdzenia |
| CFO | UNDERWRITER, kapitał i koszty modelowe | interpretuje kwoty i brak finansowania | notatka o finansowaniu nie jest ofertą kredytu; brak osobnego cash-flow |
| ACQUISITION | UNDERWRITER, RISK_LEGAL | opening/target/Max Buy i warunki negocjacji | nie kontaktuje sprzedawcy ani nie składa ofert |
| SALE | MARKET | wyjście i jakość kompów, freshness | brak niezależnej estymacji ekspozycji/rynku transakcyjnego |
| CEO | wszystkie projekcje i kanoniczne bramki | rekomendacja warunkowa, argumenty, next action | nie podejmuje decyzji zakupu za człowieka; braki prawne blokują KUP |

Pierwotnie pytania były tylko do odczytu; panel korekt zastępował cały zbiór
values i miał tylko cztery pola. Brakowało właściciela rundy, request ID,
trwałych odpowiedzi/notatek i porównania snapshotów. Engine przeliczał wszystkie
ścieżki, nawet jeśli projekcja nie zmieniała się. Historia dodatkowych projekcji
była zapisywana po CAS, a nie w tej samej transakcji.

## Radar, dane i finanse

`resolveMarketEvidence` wykorzystuje obecne selectResaleComps/calculateResaleArv,
które filtrują cechy, aktywność i jakość remontu oraz WAŻĄ daty. Istniejące
mechanizmy zapisu/deduplikacji nie są zastępowane. Sam selektor kompów nie
zapewnia niezależnej deduplikacji syndykowanych ofert między portalami ani
twardego odcięcia wieku każdej pozycji; resolver bierze najnowszą datę zestawu.
To luka P1, a nie dowód aktualności całej próbki. Resolver nie czyta bezpośrednio radar_listings: Radar Cen ma osobną ścieżkę
kwalifikacji/statystyk, której integracja z deal wymaga adaptera i jawnego
pochodzenia (P1). Nie nazywamy obecnego fallbacku cenami z Radaru.
Warstwa Q&A nie tworzy nowych kompów,
cen ani transakcji. Source/priceEvidenceType i daty są zachowane w snapshotach.
Aktywny profil/filtry pozostają niezmienione. Nie certyfikujemy tutaj, że
listing spoza profilu nigdy nie jest kamienicą: brak jawnego modelu profilu
inwestora w CanonicalDeal wymaga dalszej integracji; nie zmieniamy globalnych
reguł Radaru, aby to ukryć.

Istniejący silnik liczy koszty nabycia procentowe i stałe, remont, rezerwę,
utrzymanie, finansowanie i koszty sprzedaży, rozwiązuje Max Buy oraz wylicza
target/opening z istniejących progów. To model scenariuszowy. Nie ustala formy
prawnej, zwolnienia z PCC, VAT/PIT/CIT ani konkretnej prowizji notarialnej z samego
ogłoszenia. Potrzebne inputy: forma działalności, scenariusz podatkowy i zwolnienia,
faktyczny koszt notariusza, pośredników, kapitał i warunki finansowania, harmonogram,
zakres wykonawcy. Nie dodajemy fikcyjnej pewności ani podatku dochodowego.
Budżet remontu łączny podawany przez inwestora jest przekazywany do istniejącego
silnika jako jawna opcjonalna kwota: unika utraty groszy przez przeliczenie
100 000 PLN / 45 m² na zaokrągloną stawkę. Domyślne zachowanie innych klientów
underwritingu nie zmienia się.

## Trzy przypadki syntetyczne — Łódź

`test-fixtures/lodz-deals.ts`, ceny i adresy wyłącznie testowe, NIE dane rynku.

| Przypadek | Celowe braki | Oczekiwany bezpieczny wynik |
|---|---|---|
| Górna, blok, 45 m², 300 tys. | brak KW; deklaracja negocjacji 260 tys. | aktualizacja ceny zakupu/profit/ROI; cena ofertowa źródła pozostaje 300 tys.; brak bezwarunkowego KUP |
| Ten sam syntetyczny lokal, stan nieznany | budżet remontu 100 tys. przed rezerwą | dokładny koszt, niższy zysk i Max Buy; nie udajemy kosztorysu |
| 650 tys., 45 vs 52 m² | drogo, konflikt metrażu, brak KW | VERIFY blocked; brak bezwarunkowego KUP pomimo odpowiedzi |

## Wdrożona pętla P0 i granice

Pod flagą `DEAL_ROOM_QA_ENABLED=true` (domyślnie wyłączona): formularz inline,
1–5 pytań i kolejka, wartości liczbowe/notatki/link, nie wiem/sprawdzę później,
edytuj/cofnij. Stan prawny/link to NEEDS_EVIDENCE, nie VERIFIED. Wartość liczbowa
RESOLVED znaczy przyjęte ZAŁOŻENIE do obliczeń. Pierwotne wartości źródłowe i
konflikty pozostają. Źródłowy fingerprint otwiera pytanie ponownie po zmianie
wartości lub jej dowodów; odświeżenie daty samo nie wymusza odpowiedzi.

Zapis przechowuje aktora z requireOperator/getUser, datę, wersję, identyfikator
pytania, klasyfikację i historię przejść. Jedna transakcja obejmuje CAS aktualnego
deal, overrides, stan właściciela i immutable response z oboma BrainSnapshot.
Przegrana CAS nie zapisuje częściowych odpowiedzi. Request ID + hash zapewniają
idempotencję. Właściciel workspace jest nadawany atomowo przy pierwszej rundzie;
inny operator nie otrzyma jego odpowiedzi. Legacy model ofert jest globalny dla
operatorów; nie przerabiamy całego Findera na system wielodzierżawny.

Pozostaje do kolejnych etapów: kwalifikowany workflow VERIFIED dla dokumentów,
niezależny kosztorys i jawny cash-flow/podatki, pełna integracja profilu inwestora,
metryki break-even/sensitivity niewystawione przez obecny kontrakt, UI pełnego
paginowanego archiwum rund (ledger zachowuje wszystkie; UI pokazuje ostatnie
porównanie), rozwiązywanie konfliktów na podstawie faktycznie zweryfikowanego
dowodu i końcowe testy operatorów na zatwierdzonym staging. Nie deklarujemy,
że te braki zostały rozwiązane samym zapisaniem notatki.

Draft SQL: `supabase/drafts/deal-room-qa.sql`; nie instalować automatycznie.
Wyłączenie flagi blokuje nowe odpowiedzi i nie usuwa danych. Owner guard działa
niezależnie od flagi: owner jest także w opcjonalnej kolumnie deals, odczytywanej
przez dotychczasowe select(*). Bez draftu kolumny brak i zachowanie pozostaje
zgodne z globalnym modelem legacy. Nie cofać kodu owner guard po zapisaniu
prywatnych rund bez odcięcia dostępu do Deal Room. Zachować ledger, bez DROP.

Checkpoint finansowy: cena wynegocjowana jest odrębnym założeniem
`negotiatedPrice`, przekazanym jako istniejący `priceOverride` underwritingu.
Nie zmieniamy źródłowej ceny ofertowej ani nie usuwamy konfliktu faktów.
Zmiana listing.updated_at przed zapisem rundy wymaga jawnego odświeżenia
analizy przyciskiem (POST initialize); GET nadal nigdy nie przelicza ani zapisuje.
Legacy panel korekt nie może nadpisać wartości należących do istniejącej rundy.

Testy istniejących mechanizmów rynku/Radaru: 97/97 lokalnie (Node 24), komenda:
`node --experimental-strip-types --import ./scripts/test-alias-loader.mjs --test-isolation=none --test features/market-intelligence/*.test.mjs features/price-radar/qualification.test.ts features/price-radar/stats.test.ts`.
To testy syntetyczne; nie potwierdzają jakości aktualnych danych produkcyjnych.

Dodatkowo naprawiono błędne mapowanie kodowania tekstu „ODRZUĆ” w trwałej
projekcji ceo_decisions: wcześniej mogło zapisywać HOLD zamiast ODRZUC.
Natywny test API → serwisy → PostgREST → PostgreSQL sprawdza teraz także ten
przypadek. Nie zmieniono obliczeń kwot, progów inwestora ani źródeł produkcji.

Dodatkowe regresje P0: zachowanie niezależnie dołączonych dowodów dokumentowych
bez nadawania im VERIFIED; zachowanie dotychczasowych korekt resalePerM2
i additionalCosts w Q&A; stabilna data ręcznej stawki odsprzedaży podczas
zapisu notatki bez wpływu finansowego. Nie odmładzamy założenia przez sam
rebuild. Weryfikacja dotyczy domyślnej polityki Investment OS; alternatywne
polityki bramek wymagają osobnego przeglądu przed aktywacją.

Naprawiono też wejścia zależnego MARKET: oryginalny resolver dostawał surowe
cechy listing, więc uzupełnienie brakującego metrażu nie dobierało ponownie
kompów/assumptions. Teraz po zmianie efektywnych cech odpytywany jest ten sam
resolver; źródłowe fakty nie są nadpisywane. Natywny scenariusz usuwa metraż,
potwierdza blokadę finansów, zapisuje odpowiedź 45 m² i oczekuje odtworzenia
wyniku, przy wciąż niepotwierdzonym stanie prawnym.
