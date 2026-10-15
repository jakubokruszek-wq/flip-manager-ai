# Facebook Watcher Android Backend — kontrakt integracyjny v1

Adres bazowy: adres tego samego backendu Flip Manager. Wszystkie ścieżki poniżej
są względne. Kontrakt jest przygotowany dla klienta Android 16; nie wymaga zmian
w API Androida po stronie serwera ani nowej usługi. Katalog `android/flip-collector`
nie jest częścią tej zmiany.

## Stan wdrożenia i separacja konsumentów

Kod **nie został wdrożony**. Propozycja schematu znajduje się w
[`../supabase/drafts/android-webview-backend.sql`](../supabase/drafts/android-webview-backend.sql).
Nie została wykonana na Supabase. Przed użyciem endpointów należy sprawdzić SQL
w odizolowanym PostgreSQL i promować go do migracji przez `supabase migration new`.
Schemat musi poprzedzić wdrożenie kodu, ponieważ autoryzacja odczytuje nową kolumnę
`collector_devices.consumer_type`. Istniejące urządzenia otrzymują domyślnie
`BROWSER_EXTENSION`; ich tokeny i podpisy pozostają takie same.

`FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED=true` włącza opcjonalne snapshoty jakości i wewnętrzny odczyt raportu; domyślnie wyłączone. Planer jest funkcją bez skutków ubocznych, wyłączoną domyślnie i niepodłączoną do cron.

`FACEBOOK_ANDROID_QUEUE_ENABLED=true` pozwala odbierać nowe zadania; domyślnie
kolejka Androida jest wyłączona. Wyłączenie zatrzymuje nowe odbiory, ale pozwala
odnowić lease i zakończyć wcześniej odebrane zadanie. Nie zmieniono konfiguracji
Vercel ani zmiennych produkcyjnych.

Istniejący scheduler, jego blokada, status i timeouty nadal obsługują wyłącznie
`BROWSER_EXTENSION`. Readiness i wybór urządzenia do blokady schedulera filtrują
ten typ, więc heartbeat telefonu nie udaje działającej przeglądarki. Android nie
wywołuje schedulera podczas odbioru ani zakończenia zadania.

Zadania Androida tworzy jawne wywołanie backendowej funkcji
`enqueueFacebookJobs(filter, runId, sourceId, "ANDROID_WEBVIEW")`. Jest to punkt
integracji dla przyszłego, oddzielnego schedulera Androida, a nie nowy publiczny
endpoint do uruchamiania skanów. Domyślna wartość funkcji pozostaje
`BROWSER_EXTENSION`. Nie przekierowujemy istniejących zadań ani nie kopiujemy
kolejki przeglądarki. Klucz idempotencji pozostaje wspólny dla tego samego
filtra/runu/grupy: ponowne enqueue tego samego zadania dla drugiego konsumenta
nie tworzy drugiego zadania. Używaj odrębnych runów dla odrębnych cykli.
Android nie dostaje `GALLERY_HYDRATION` ani `LEGACY_WORKER`.

## Parowanie i przechowywanie tokena

Zaufany proces parowania używa istniejącego
`POST /api/collector/pairing/complete` (challenge oraz cookie parowania) lub
administracyjnego `POST /api/collector/devices/register` (istniejący sekret
parowania w nagłówku). Do JSON dodaje:

```json
{"deviceName":"Android Watcher", "installationId":"stabilny-id-instalacji", "consumerType":"ANDROID_WEBVIEW"}
```

Pierwsza ścieżka wymaga również istniejącego pola `challenge`. Odpowiedź `201`:
`{"deviceId":"uuid", "deviceToken":"token"}`. Brak `consumerType` nadal oznacza
przeglądarkę. Typ jest zapisany na serwerze; nagłówek lub body zadania go nie zmienia.
Istniejący token sparowany jako przeglądarka nie uprawnia do kolejki Androida:
trzeba sparować osobną instalację Androida. Obecny interfejs parowania nie dodaje
tego pola automatycznie — jego wywołujący musi wskazać Androida.

Token urządzenia przechowuj w chronionym magazynie Androida, poza WebView i
JavaScript. Nie umieszczaj globalnego sekretu parowania, klucza Supabase service
role ani ciasteczek Facebooka w APK czy payloadach Collectora. Serwer nie potrzebuje
sesji Facebooka. Istniejący ręczny import przez bearer token pozostaje oddzielnym
przepływem i nie służy do kończenia zadań Watchera.

## HMAC — identyczny algorytm jak w Collectorze

Każdy request do kolejki jest `POST`, HTTPS, `Content-Type: application/json`.
Podpisuj dokładnie te bajty UTF-8 JSON, które wysyłasz; po podpisaniu nie serializuj
obiektu ponownie. Nagłówki:

| Nagłówek | Wartość |
| --- | --- |
| `X-Flip-Collector-Device-Id` | `deviceId` z parowania |
| `X-Flip-Collector-Timestamp` | czas Unix w **milisekundach**, zapis dziesiętny |
| `X-Flip-Collector-Nonce` | nowy UUID lub 16–128 znaków `[A-Za-z0-9_-]` |
| `X-Flip-Collector-Signature` | HMAC-SHA256 jako 64 małe znaki hex |

```text
signingKey = lowercaseHex(SHA256(UTF8(deviceToken)))
bodyHash   = lowercaseHex(SHA256(UTF8(rawJsonBody)))
canonical  = timestamp + "\n" + nonce + "\n" + "POST" + "\n" + pathname + "\n" + bodyHash
signature  = lowercaseHex(HMAC_SHA256(UTF8(signingKey), UTF8(canonical)))
```

Klucz HMAC to **64 bajty tekstu hex**, nie 32 surowe bajty SHA256.
`pathname` to dokładna ścieżka endpointu, bez hosta, query i końcowego slash.
Tolerancja zegara: ±5 minut. Nonce jest atomowo rezerwowany w istniejącej tabeli
`collector_request_nonces`, osobno dla urządzenia. Każde ponowienie HTTP wymaga
nowego nonce i podpisu; body zakończenia pozostaje identyczne.

## Odbiór zadania

`POST /api/collector/android/jobs/claim`, body `{}`.

```json
{
  "ok": true,
  "code": "JOB_CLAIMED",
  "job": {
    "id": "uuid-zadania",
    "runId": "uuid-runu",
    "sourceScanId": "uuid-skanu",
    "filterId": "uuid-filtra",
    "consumerType": "ANDROID_WEBVIEW",
    "jobType": "SOURCE_SCAN",
    "imageMode": "SOURCE_SCAN_DATA_ONLY",
    "group": {"id":"uuid-rejestru", "name":"Nazwa", "sourceId":"identyfikator-facebooka", "type":"GROUP", "url":"https://www.facebook.com/groups/identyfikator-facebooka/"},
    "leaseToken": "uuid-lease",
    "leasedUntil": "2026-10-14T23:03:00.000Z",
    "attempts": 1,
    "heartbeatIntervalSeconds": 45
  }
}
```

`group.type` może też być `PROFILE`. `group.id` to wpis rejestru; **batch.sourceId
musi pochodzić z group.sourceId**, nie z group.id. Odpowiedź `200` z `job:null`
ma kod `NO_PENDING_JOB` albo `ANDROID_QUEUE_DISABLED`. Bez zadania odczekaj
30–60 sekund z losowym rozrzutem. Serwer nie zwraca tokena urządzenia ani lease
innego urządzenia.

Lease trwa 180 sekund. Odzyskane zadania dostają opóźnienie 15–300 sekund z deterministycznym jitterem; każda nowa próba dostaje nowy token. Odzyskiwanie działa podczas kolejnego odbioru Androida, nie przez istniejący cron. `FOR UPDATE SKIP LOCKED` rozdziela zadania między telefony;
blokada transakcyjna urządzenia serializuje jego równoległe odbiory. Powtórny odbiór
w czasie ważnego lease zwraca **to samo zadanie i token**, bez nowej próby.
Klient musi utrzymywać jeden wykonawca dla `(job.id, leaseToken)` i wznowić go,
a nie uruchamiać drugi WebView. Zadania z wygasłym lease mogą wrócić do kolejki
z nowym tokenem do limitu prób, z wyjątkiem zarezerwowanych importów.

## Heartbeat zadania

`POST /api/collector/android/jobs/heartbeat`:

```json
{"jobId":"uuid-zadania", "leaseToken":"uuid-lease"}
```

Co 45 sekund podczas pracy; `200 {"ok":true,"leasedUntil":"ISO-8601"}`.
Serwer sprawdza typ konsumenta, typ zadania, status `running`, urządzenie, token
oraz termin lease według zegara bazy. `409 ANDROID_JOB_LEASE_LOST` oznacza:
przerwij wykonanie i nie importuj wyników pod starym lease. Heartbeat urządzenia
zapisuje również podpisany odbiór/poll; nie zastępuje on heartbeat zadania.
Android 16 może wstrzymać proces: nie zakładaj, że lease przetrwa uśpienie.

## Zakończenie i payload ofert

`POST /api/collector/android/jobs/complete` przy sukcesie:

```json
{
  "jobId":"uuid-zadania", "leaseToken":"uuid-lease",
  "completionId":"nowy-uuid-generowany-raz", "dataMode":"LIVE", "status":"completed",
  "batch": {
    "scanId":"runId-z-claim", "batchId":"ten-sam-uuid-co-completionId",
    "sourceId":"group.sourceId", "sourceType":"GROUP", "sourceUrl":"group.url",
    "collectedAt":"2026-10-14T23:00:00.000Z", "imageMode":"SOURCE_SCAN_DATA_ONLY",
    "health": {"status":"HEALTHY", "visibleCardCount":0, "capturedPostCount":0, "scrolls":0, "durationMs":0, "stopReason":"NO_NEW_IDS", "reasons":[]},
    "posts": []
  }
}
```

Przykład schematu jednego elementu `posts` (dołącz go tylko przy rzeczywistym
dowodzie tożsamości posta, nie wywnioskuj `EXACT` z podobnego tekstu):

```json
{
  "postId":"123456789012345", "permalink":"https://www.facebook.com/groups/identyfikator-facebooka/posts/123456789012345/",
  "sourceId":"identyfikator-facebooka", "sourceType":"GROUP",
  "author":"Autor", "text":"Treść źródłowa", "publishedAt":"2026-10-14T22:00:00.000Z",
  "timestampText":null, "identityConfidence":"EXACT", "identityReasons":[],
  "discoveryLayers":["DOM"], "firstSeenIteration":0, "media":[],
  "discoverySource":"MAIN_FEED", "foundInMainFeed":true, "firstSeenPhase":"MAIN_FEED"
}
```

Pełny wspólny typ: `FacebookCollectorBatch` i `CollectorPostRecord` w
`features/collector/facebook-batch.ts`. Opcjonalne telemetry nie zmieniają
kryteriów ofert. `health.status`: `HEALTHY`, `DEGRADED` albo `FAILED`.
`capturedPostCount` musi zgadzać się z liczbą unikalnych postów po deduplikacji;
`visibleCardCount` opisuje widoczne karty. Maksymalnie 150 elementów wejściowych
`posts` i 2 MiB UTF-8 dla całego requestu, także bez `Content-Length`.

Normalizator pozostaje wspólny: weryfikuje URL/źródło, deduplikuje postId i
normalizuje daty. Polityka importu wymaga `EXACT`, świeżości do 72 godzin i braku
konfliktu z historią tożsamości. Oferty przechodzą przez istniejące reguły ceny,
lokalizacji, intencji, zgodności z filtrem i deduplikacji. Import używa wyłącznie
`sourceScanId` oraz snapshotu filtra z odebranego zadania; nie wybiera bieżącego
aktywnego filtra, gdy zabraknie przypisanego skanu.

Zdjęcia: źródłowy skan pozostaje `SOURCE_SCAN_DATA_ONLY`; nie pobieraj galerii,
miniatur ani obrazów i nie wysyłaj screenshotów/base64. Jeśli źródło już dostarczyło
metadane mediów, obowiązuje istniejący `CollectorMediaRecord` (`url`, `mediaId`,
`exactPostId`, `exactAssociation`, `discoveryLayers`). Media muszą być przypisane
do dokładnego korzenia posta. Backend nie podnosi niezweryfikowanych mediów do
pewnego dowodu; zachowuje istniejące stabilne zdjęcia. Ścieżka Androida nie uruchamia
Vision ani nowego mechanizmu pobierania zdjęć. Backend obejmuje cały batch izolowanym
kontekstem AsyncLocalStorage data-only, który blokuje opcjonalne zadania tła
`runAfterResponse` (galeria i analiza AI zdjęć). Kontekst nie obejmuje równoległych
żądań Chrome/OLX i nie zmienia ich zachowania. Krytyczne zapisy batcha są awaitowane,
nie uruchamiane jako opcjonalne zadania tła. Hydratacja galerii nie jest objęta v1.

Przy błędzie zbierania zamiast batch:

```json
{"jobId":"uuid-zadania", "leaseToken":"uuid-lease", "completionId":"nowy-uuid", "dataMode":"LIVE", "status":"failed", "errorCode":"LOGIN_REQUIRED"}
```

`errorCode`: 1–100 znaków `[A-Z0-9_]`, np. `LOGIN_REQUIRED`, `CHECKPOINT`,
`NETWORK_ERROR`, `WEBVIEW_STOPPED`. Nie przesyłaj ciasteczek, tokenów, HTML sesji
czy surowych wyjątków. Nie omijaj logowania/checkpointu automatycznym skanowaniem.

Sukces HTTP: `200 {"ok":true,"completionId":"uuid","status":"completed|failed","result":{...}|null}`.
`status` opisuje wynik backendu; batch z nieudanym importem może zakończyć zadanie
jako `failed`, mimo zgłoszonego `completed`. Wynik `degraded` znajduje się w
`result.status`. Pusty wynik zdrowego skanu jest dozwolony.

## Idempotencja, awarie i kody błędów

Przed wysłaniem zapisz `completionId` i dokładny JSON w lokalnym outboxie.
Ponowienie używa tego samego JSON, nowego nonce i nowego podpisu. Serwer zapisuje
SHA256 całego body, rezerwuje import atomowo i zwraca zapisany receipt przy
identycznym ponowieniu, także po zakończeniu lease. Inne body/completionId dla
tego samego zadania dostaje konflikt. Nie generuj nowego completionId po timeout.

| HTTP | Kod | Działanie klienta |
| --- | --- | --- |
| 400 | `INVALID_PAYLOAD` | popraw kontrakt, nie ponawiaj bez zmiany przyczyny |
| 401 | błędy HMAC, `INVALID_DEVICE`, `REPLAYED_NONCE` | sprawdź zegar/podpis; replay ponów z nowym nonce; token cofnięty wymaga parowania |
| 403 | `COLLECTOR_CONSUMER_MISMATCH` | użyj urządzenia sparowanego jako Android |
| 409 | `ANDROID_JOB_LEASE_LOST` | przerwij stare zadanie |
| 409 | `ANDROID_COMPLETION_CONFLICT` | nie zmieniaj body już zarezerwowanego zakończenia |
| 409 | `ANDROID_COMPLETION_IN_PROGRESS` | import trwa lub wymaga uzgodnienia stanu; nie zbieraj ponownie |
| 409 | `ANDROID_BATCH_REQUIRES_RECONCILIATION`, `ANDROID_COMPLETION_REQUIRES_RECONCILIATION` | eskaluj operatorowi, bez ponownego importu |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `JSON_REQUIRED` | popraw rozmiar/typ requestu |
| 422 | `ANDROID_BATCH_INVALID`, `ANDROID_BATCH_JOB_MISMATCH` | popraw dane źródła i powiązanie z claim |
| 503 | `ANDROID_QUEUE_UNAVAILABLE`, `ANDROID_REQUEST_FAILED`, `ANDROID_RECEIPT_INVALID`, `ANDROID_PROCESSING_RESULT_INVALID` | backoff i ponowienie tego samego body z nowym podpisem |

Importu ofert **nie uruchamiamy ponownie automatycznie**. Jeżeli batch ma już trwały wynik końcowy, identyczny request może odzyskać wyłącznie finalizację zadania. Odczyt jest związany z urządzeniem, completionId/batchId, runId, źródłem i sourceScanId. Jeśli wynik nie jest kompletny lub powiązanie jest niejednoznaczne, rezerwacja pozostaje zablokowana, nawet po wygaśnięciu lease: zapisy ofert mogą być częściowo zatwierdzone. Jest to ochrona przed
ponownymi skutkami ubocznymi, a nie obietnica atomowego „exactly once” całego
importu. Operator sprawdza `android_completion_state`, `android_completion_started_at`,
`collector_scan_batches`, skan źródła oraz zapisane oferty. Dopiero po uzgodnieniu
uzupełnia receipt/finalizuje stan w kontrolowanym narzędziu administracyjnym.
Nie zeruj samej rezerwacji i nie kieruj wyniku do ogólnego endpointu importu.

## Odczyt statusu po utracie połączenia

`POST /api/collector/android/jobs/status` jest podpisany HMAC tak samo jak inne
ścieżki, z własnym pathname. Body:

```json
{"jobId":"uuid-zadania", "leaseToken":"uuid-lease"}
```

Odpowiedź `200`:

```json
{
  "ok": true, "jobId":"uuid-zadania", "status":"running",
  "completionState":"PROCESSING", "leasedUntil":"2026-10-15T06:03:00.000Z",
  "receipt": null, "retryAfterSeconds": 15
}
```

`status` to `queued|running|completed|failed`. `completionState`:

| Stan | Znaczenie i działanie |
| --- | --- |
| `NONE` | Brak rezerwacji importu. Pracuj tylko przy ważnym lease; heartbeat potwierdza jego ważność. |
| `PROCESSING` | Import trwa albo kończy zapis potwierdzenia. Powtórz dokładne body complete z nowym HMAC, bez ponownego zbierania postów. |
| `SETTLED` | `receipt` zawiera trwałą odpowiedź complete; usuń pozycję z outboxu po jej zapisaniu. `leasedUntil` jest null. |
| `RECONCILIATION_REQUIRED` | Rezerwacja trwa ponad 5 minut albo nie ma poprawnego czasu rozpoczęcia. Wstrzymaj automatyczne ponawianie, zgłoś operatorowi; to sygnał diagnostyczny, nie automatyczne zwolnienie blokady. |

Czas 5 minut nie zabija działającego importu. Właściciel/token nadal obowiązują.
Status nie ujawnia tokenów, cudzych zadań ani danych sesji Facebooka. Odpowiedź
`409 ANDROID_JOB_LEASE_LOST` przy starym tokenie po odzyskaniu przez inne urządzenie
jest oczekiwana, także dla statusu. Status nie odnawia lease.

Błędy handlera mają format:

```json
{"ok":false,"code":"ANDROID_QUEUE_UNAVAILABLE","retryable":true,"retryAfterSeconds":15}
```

`retryable=true` otrzymują 503 i `ANDROID_COMPLETION_IN_PROGRESS`; odpowiedź ma
również `Retry-After: 15`. Retry dotyczy **tego samego żądania z nowym podpisem**,
nie powtórnego importu ani skanu. Po `RECONCILIATION_REQUIRED` klient zatrzymuje
automatyczne ponawianie. Przy innych błędach `retryAfterSeconds=null`.
`ANDROID_PROCESSING_RESULT_INVALID` oznacza 503 z nieprawidłowym wynikiem
wewnętrznym — nie czyść rezerwacji, zgłoś problem operatorowi. Wszystkie odpowiedzi
mają `Cache-Control: no-store`. Metody inne niż POST: 405; zły typ body: 415.

## Raport jakości po stronie serwera

Model `FacebookQualityReport` i funkcja `buildFacebookRunQualityReport` znajdują się
w `features/collector/android/quality.ts`. Wewnętrzna funkcja serwerowa
`readFacebookRunQualityReport({runId, consumerTypes})` w `quality-server.ts` jest
wyłączona domyślnie i nie jest publicznym endpointem. Konsument domyślny to Android;
administrator może jawnie zestawić Android i Chrome w jednym raporcie runu.

Raport ma pola:

- `version=1`, `source=facebook`, `runId`, `generatedAt`, `consumerTypes`;
- `groups.planned`, `attempted`, `scanned`, `successful`, `failed` — unikalne źródła;
  `scanned/successful` oznaczają zadania ukończone, a `attempted` również rozpoczęte
  i nieudane próby. Źródło z wieloma zadaniami może wystąpić w kilku kategoriach;
- `metrics.postsCaptured`, `postsWithSaleIntent`, `postsWithConfirmedIdentity`,
  `postsWithMissingData`, `postsRejected`, `listingsAdded`, `listingsUpdated`,
  `processingErrors`; każdy licznik ma `{value, observedJobs, totalJobs}`;
- `rejectionReasons`, `missingDataReasons` — liczności kodów istniejącego pipeline;
  przyczyny mogą się nakładać i nie sumują się do liczby postów;
- `failures.terminalScans`, `leaseRecoveries` i `coverage` z ostrzeżeniami.

Brak historycznie zapisanego licznika to **null**, nie zero. Gdy obserwowano tylko
część zadań, `value` sumuje znane obserwacje i nie jest estymacją całego runu.
`postsWithSaleIntent` używa istniejącego deterministycznego klasyfikatora intencji,
a nie Vision; `postsWithMissingData` liczy posty z kodami `unknown_*` w decyzji,
jednokrotnie na post, nawet przy kilku brakujących polach. Nie potwierdza tożsamości
na podstawie samego tekstu. `listingsAdded/Updated` pozostają **null**, gdy importer zgłasza dodatnie
obserwacje zapisu bez atomowego potwierdzenia autorstwa INSERT/UPDATE. Nie sumujemy
ich jako liczby fizycznie dodanych lub zmienionych ofert: równoległy konsument
może zapisać ten sam rekord, także poza raportowanym runem. Jawne zera można
raportować tylko w zakresie obserwowanych zadań; dodatnia niepotwierdzona
obserwacja unieważnia zero zbiorcze.
`writeObservations.reportedCreated/reportedUpdated` zachowują historyczne
obserwacje operacji (nie count distinct), a `coverage.warnings` zawiera
`DISTINCT_LISTING_WRITES_UNVERIFIED`. Klient nie może pokazywać tych obserwacji jako
liczby nowych ofert. Dokładne dodatnie liczniki wymagają osobnego atomowego
rejestru zapisów w bazie; nie wdrożono go na produkcji.

Snapshot jakości powstaje tylko przy `FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED=true`.
Raport nie zmienia ocen, filtrów, zdjęć ani lifecycle ofert. Odczyt obejmuje tylko
zadania Facebooka `SOURCE_SCAN` i ściśle wskazany run/konsument. Nie czyta OLX.
Odrzuca zakres ponad 500 zadań lub 1000 batchy zamiast po cichu obcinać statystyki.
Wymaga dokładnego count i odrzuca niepełny odczyt (`FACEBOOK_REPORT_COUNT_UNAVAILABLE`,
`FACEBOOK_REPORT_TRUNCATED`), także przy limicie wierszy narzuconym przez PostgREST.

## Plan kolejności grup i brak dostępu do danych

Odczyt grup/historii z Supabase w tej sesji nie zakończył się wynikiem.
Użytkownik potwierdził 15 źródeł, 13 aktywnych dla Łodzi: 11 grup i 2 profile;
jeden profil jest UNAVAILABLE. Nie pobrano nazw, URL-i ani historii skuteczności.
[`facebook-android-groups-analysis.md`](facebook-android-groups-analysis.md) opisuje
model rankingu i brakujące dane. Skrypt `scripts/facebook-android-plan-preview.mjs`
pracuje wyłącznie na lokalnym eksporcie JSON; nie łączy się z Facebookiem lub bazą
ani nie uruchamia harmonogramu. Istniejące harmonogramy pozostają bez zmian.

## Weryfikacja lokalna

`npm run test:facebook-android` uruchamia testy jednostkowe i integracyjne z
mockowanymi RPC/Supabase, prawdziwym HMAC, handlerem HTTP i wspólną orkiestracją
batch. Działa z Node 24. Testy nie łączą się z Facebookiem, Supabase ani OpenAI.
Użyto `--test-isolation=none`, ponieważ w tym środowisku domyślna izolacja Node
raportowała tylko pliki bez uruchamiania zagnieżdżonych testów.

Testy mocków i sprawdzenie zabezpieczeń SQL nie zastępują wykonania draftu na
odizolowanym PostgreSQL. Pełny build Next/TypeScript i taki test bazy pozostają
niewykonane w tym środowisku: nie zainstalowano zależności, a proxy dla pobrania
repozytorium jest niedostępne. Nie wykonano skanów, merge ani deploymentu.

## Rozszerzenie integracyjne: źródła, urządzenie i diagnostyka

Domyślnie wyłączone: `FACEBOOK_ANDROID_INTEGRATION_ENABLED=true` jest wymagane
oddzielnie od bramki kolejki. Wszystkie poniższe endpointy to podpisany POST JSON
z tym samym HMAC, ochroną nonce i consumerem ANDROID_WEBVIEW. Brak Bearer fallback.

- `/api/collector/android/device/status`, body `{}`: `{ok:true,deviceId,
  consumerType:"ANDROID_WEBVIEW",paired:true,imageMode:"SOURCE_SCAN_DATA_ONLY",
  heartbeatIntervalSeconds:45}`. Nie zwraca sekretu i nie oznacza gotowości Chrome.
- `/api/collector/android/sources/sync`, body `{}`: `{ok:true,completeSnapshot:true,
  sources:[{id,name,url,sourceId,type,priority,enabled,serverEnabled,accessStatus,
  unavailableCode}]}`. `type` GROUP/PROFILE lub null dla błędnego URL;
  url/sourceId również null przy błędzie. Niedostępne źródło pozostaje w pełnym
  snapshot z enabled=false. Brakujący ID po udanej pełnej synchronizacji oznacza
  usunięcie/odebranie dostępu; lokalne wyłączenie pozostaje niezależne od serwera.
- `/api/collector/android/diagnostics`, body `{jobId,leaseToken}`: identyczny
  format i kontrola właściciela jak jobs/status, w tym receipt z wynikiem jakości.
  Nie jest globalnym raportem wszystkich urządzeń lub runów.

Bez flagi: HTTP503 `ANDROID_INTEGRATION_DISABLED`, bez fałszywego pustego
snapshotu. Błędy odczytu/ucięty snapshot: HTTP503 `ANDROID_SOURCE_SNAPSHOT_INVALID`
lub `ANDROID_METADATA_UNAVAILABLE`. Limit 50 unikalnych źródeł, body 8192 bajty.

Uprawnienia: nowa tabela draftu `collector_android_source_grants` zawiera jawne
(device_id,watched_group_id,search_filter_id,expires_at). Domyślnie pusta, RLS,
bez dostępu anon/authenticated. Synchronizacja korzysta wyłącznie z ważnych
uprawnień uwierzytelnionego urządzenia; body nie wybiera urządzenia. Claim nowego
zadania wymaga pasującego źródła i filtra. Nie nadajemy uprawnień automatycznie
podczas parowania i nie korzystamy z aktywnego filtra Flip jako fallback.

### Anulowanie

`POST jobs/complete` dopuszcza `{jobId,leaseToken,completionId,dataMode:"LIVE",status:"cancelled"}`
bez batcha. Rezerwacja i fencing pozostają takie same. Trwały receipt ma
`status:"failed",result:{cancelled:true}`, a kod bazy `ANDROID_CANCELLED` —
nie rozszerzamy historycznego enum statusów kolejki. Ponowienie musi zachować
identyczne bajty, także przy anulowaniu. Po wysłaniu batcha nie zastępujemy go
innym body cancelled; najpierw uzgadniamy status/outbox. Ręczne stop nie cofa
już zatwierdzonych ofert. Raport oddziela `failures.cancelledScans` od błędów.

## Separacja domen danych

Każdy complete/failed/cancelled wymaga root `dataMode:"LIVE"`. Publiczny handler
odrzuca DEMO, brak pola i OFFLINE_TEST kodem 422 ANDROID_DATA_DOMAIN_MISMATCH.
Wyłącznie lokalny serwer testowy CI jawnie wymaga OFFLINE_TEST; nie ma flagi
środowiskowej zezwalającej produkcyjnemu route na przyjęcie danych testowych.
Klient Kotlin dopuszcza OFFLINE_TEST wyłącznie dla loopback fixture origin.
DEMO nigdy nie korzysta z kolejki ani outboxa. Podpis obejmuje również dataMode.

## 0.6 offline integration additions

Claim may include `sourceIds: string[]` (0–50 unique watched-source UUIDs).
`{}` preserves the previous polling contract; `[]` claims nothing. This is an
additional restriction intersected with server device grants and source status,
never an authorization grant. A running job outside the selection prevents new
claims for that device; recover/cancel the stored lease first. Draft SQL now uses
`claim_android_facebook_scan_job(uuid, integer, uuid[] default null)`.

The offline fixture requires `dataMode=OFFLINE_TEST`. It is a loopback HTTPS
service only, uses synthetic credentials, a pinned ephemeral certificate, an
isolated PostgreSQL database and no Supabase production client. Production routes
still require LIVE mode, and both Android production gates remain false. Neither
DEMO nor production outboxes/cursors are read by the offline automation engine.

Fixture completion results include `skipped` and `writeAccounting`:
`{version:1,basis:"TRANSACTIONAL",created:number,updated:number,duplicates:number}`.
Counts come from the same database transaction as the persisted receipt. An
unchanged existing listing is a duplicate, not an update. Replaying a completion
returns its persisted receipt without new writes or count increments. The Android
journal stores a result keyed by completion ID atomically with cursor advancement
before clearing exact outbox bytes. Unknown historical production write counts
remain unknown; this fixture evidence does not certify production Finder counters.

The isolated fixture opts into `atomicOfflineImportReplay` in server dependencies
(not in request JSON). It is honored ONLY with server `expectedDataMode=OFFLINE_TEST`.
When the completion is reserved and its batch checkpoint is absent, it may rerun
that atomic adapter with the exact same batch ID; database batch locks and the
unique persisted checkpoint serialize concurrent attempts. LIVE ignores the flag
and retains the previous reconciliation fence. This opt-in must not be copied to
the non-atomic production Finder importer.

### 0.7 isolated preparation (not deployed)

`FACEBOOK_ANDROID_ATOMIC_FINDER_ENABLED` defaults to false. The optional draft
`supabase/drafts/android-facebook-finder.sql` adds per-post transactional Finder
writes, canonical membership, metadata, history, group increments and receipt.
A verified completion's internal job/device/lease/completion/body-hash context is
passed to the RPC; clients cannot request atomic mode or supply this context in
JSON. A replay of the same job/post returns the original operation witness;
a new job reports unchanged content as DUPLICATE. `writeAccounting` is emitted
only when every persisted post has a validated transaction witness, one target
filter is used, and there are no processing errors. Historical/legacy positive
observations remain unverified. Ambiguous whole-batch replay is still fenced.

Remote OFFLINE_TEST preparation uses a dedicated compiled test origin and a
separate provisioned 256-bit device token. The private setup JSON is version 1,
`dataMode: "OFFLINE_TEST"`, `origin`, `deviceId`, `deviceToken` (43 base64url chars)
and `expiresAt` (epoch milliseconds, maximum seven days). It is pasted into the
debug APK and encrypted using Android Keystore-backed storage; never put it in
Git/CI logs. Default APK has an empty approved remote origin and cannot enable
remote test. HTTP, redirects, the production origin and Supabase project URLs
are rejected. The request HMAC protocol is unchanged. The remote server refuses
production keys, enabled production queues, the shared CI fixture key and all
`/__test/*` controls. No remote environment is currently running; operator
approval and a separately isolated durable database are required first.
