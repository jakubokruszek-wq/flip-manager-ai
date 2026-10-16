# Deal Room Q&A — kontrakt P0 (Issue #24)

Funkcja domyślnie nieaktywna: `DEAL_ROOM_QA_ENABLED` musi być dokładnie `true`.
Wymaga uprzedniej ręcznej weryfikacji draftu SQL na izolowanym środowisku.
Kod/CI nie wykonują wdrożenia ani produkcyjnej migracji.

## Zapis i odczyt

`GET /api/flip-finder/listings/{listingUuid}/investment/answers`

Wymaga istniejącej sesji operatora (getUser + app_metadata.role). Przy wyłączonej
funkcji: `{ "enabled": false }`. Przy włączonej: `{ enabled: true, room }`.
Room zawiera version bieżącego CAS deal, answers, baselineOverrides oraz ostatnią
rundę z before/after BrainSnapshot. Pełne immutable odpowiedzi kolejnych requestów
są zachowane w backendowym ledgerze `deal_room_rounds`; pełne paginowane UI
historii nie jest częścią tego P0. GET niczego nie przelicza ani nie zapisuje.

`POST /api/flip-finder/listings/{listingUuid}/investment/answers`

Sesja operatora, Content-Type application/json, origin zgodny z serwerem, jeśli
przeglądarka wysyła Origin. Właściciel zawsze pochodzi z uwierzytelnionej sesji,
a nie z JSON. Przykład (identyfikatory syntetyczne):

```json
{
  "requestId": "44444444-4444-4444-8444-444444444444",
  "expectedVersion": 1,
  "answers": [
    { "field": "negotiatedPrice", "kind": "VALUE", "value": 260000,
      "basis": "DECLARATION", "evidenceUrl": null },
    { "field": "renovationBudget", "kind": "VALUE", "value": 100000,
      "basis": "ASSUMPTION", "evidenceUrl": null },
    { "field": "legalStatus", "kind": "LATER", "value": null,
      "basis": "DECLARATION", "evidenceUrl": null }
  ]
}
```

Odpowiedź: `{ ok: true, deal: CanonicalDeal, room, invalidated: BrainDirectorId[] }`.
Snapshoty obejmują istniejące wyniki i ich pochodzenie. `invalidated` oznacza
zależności wynikające z grafu; przy identycznym wyniku i pochodzeniu zachowujemy
poprzedni track/czas. Nie oznacza uruchomienia niezależnego agenta AI.

Cena `negotiatedPrice` jest założeniem ceny zakupu dla priceOverride istniejącego
kalkulatora. `askingPrice` jest korektą faktu źródłowego i przy sprzeczności
blokuje VERIFY; nie używać go do symulowania rabatu. `renovationBudget` to PLN
łącznie PRZED rezerwą; rezerwę dolicza dotychczasowy silnik. `areaM2` jest w m²,
`holdingMonths` w miesiącach. Istniejące założenia podatków/finansowania nie są
faktami; notatka financing ich nie zmienia automatycznie.

Od 1 do 20 unikalnych pól na request, maksymalnie 24 KB JSON. Kwoty muszą być
liczbami JSON, skończonymi i w granicach parsera. Tekst: 1–2000 znaków. Nieznane
pola odpowiedzi i duplikaty są błędem. `kind`: VALUE / UNKNOWN / LATER / WITHDRAW.
`basis`: DECLARATION / ASSUMPTION / DOCUMENT_REFERENCE. Link: HTTPS bez loginu,
hasła, query i fragmentu; nigdy nie jest pobierany automatycznie. Bez uploadu
plików i bez automatycznej oceny dokumentów. Nie wpisywać danych osób, haseł,
sesji ani tokenów. Interfejs renderuje tekst jako tekst, nie HTML.

## Semantyka dowodów i workflow

Brak odpowiedzi = OPEN. VALUE zapisuje przejścia OPEN → ANSWERED → RESOLVED
wyłącznie dla typowanej wartości liczbowej przyjętej jako założenie. Inne
ustalenia mają OPEN → ANSWERED → NEEDS_EVIDENCE. Link NIE awansuje odpowiedzi
do VERIFIED lub faktu potwierdzonego prawnie. UNKNOWN/LATER/WITHDRAW zachowują
historię, stan OPEN i nie zmieniają liczb. WITHDRAW przywraca właściwą wartość
sprzed Q&A, bez usuwania niezależnych odpowiedzi lub notatek. Profesjonalne
VERIFIED wymaga osobnego, jeszcze niewdrożonego workflow uprawnień i dowodów.

Zapisana odpowiedź zawiera actorId, savedAt, questionId, sourceFingerprint,
klasyfikację i przejścia. Istotna zmiana wartości źródłowej/dowodów otwiera pytanie
ponownie. Rebuild nie promuje deklaracji do dowodu; brak KW/konflikt metrażu nadal
nie pozwalają na bezwarunkowe KUP. Żaden zakup nie jest autonomiczny.

## Wersja, retry i błędy

Cała nowa runda jest jedną transakcją: aktualny CanonicalDeal przez istniejący
CAS, overrides, owner state i receipt obu snapshotów. Lock deal serializuje
zapisy; lock źródła stabilizuje source_updated_at. Rozbieżna wersja/source
wycofuje CAŁY zapis. Kopie round response pozostają niezmienne.

Po błędzie sieci/503 ponawiać dokładny JSON z tym samym requestId/version.
Ten sam request/SHA-256 znormalizowanego polecenia zwraca oryginalny receipt bez nowej rundy. Zmienione body
wymaga nowego requestId; ponowne użycie ID z inną treścią = konflikt.
Po 409 zachować szkic, jawnie odświeżyć analizę (POST istniejącego initialize),
pobrać stan GET i świadomie zapisać nową rundę. Nie nadpisywać wersji w ciemno.
Starego panelu override nie można użyć do wyczyszczenia istniejącej rundy Q&A.

| HTTP | Znaczenie |
|---|---|
| 200 | odczyt/zapis/receipt replay |
| 400 | polski komunikat walidacji; popraw dane |
| 401/403 | brak sesji operatora / roli lub obcy Origin |
| 404 | brak rekordu, obcy właściciel lub wyłączony zapis; bez ujawniania cudzych odpowiedzi |
| 409 | VERSION_CONFLICT albo USE_DEAL_ROOM_ANSWERS; szkic wymaga uzgodnienia |
| 413/415 | nadmierny JSON / niewłaściwy Content-Type |
| 503 | niedostępność persystencji; identyczny retry, bez logowania treści |

Nowe tabele: RLS włączone, zero grantów dla anon/authenticated/PUBLIC.
Service role: bieżący workspace SELECT/INSERT/UPDATE; ledger wyłącznie
SELECT/INSERT. RPC SECURITY INVOKER, jawny search_path, execute tylko service.
Aplikacja musi sprawdzać właściciela także na legacy GET/PUT/initialize również
po wyłączeniu funkcji (owner guard niezależny od flagi). Pierwszy operator atomowo obejmuje workspace. Model całego
Findera pozostaje wspólny dla operatorów; nie jest to migracja całej aplikacji
do multi-tenancy. Wyłączenie flagi nie wyłącza kontroli właściciela: optional deals.deal_room_owner_id
jest czytane przez select(*) także po wyłączeniu Q&A. Przed cofnięciem samego
kodu owner guard odciąć dostęp do Deal Room; zachować ledger i prywatne workspace.
