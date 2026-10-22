# Przygotowanie kontrolowanego pilota — jedna grupa, do 20 postów

Status: **pakiet przygotowawczy, brak aktywacji i brak transportu w APK 0.5.8**.
Nie jest to gotowość do produkcyjnego LIVE. Lokalny podgląd pozostaje lokalny.

## Konkretny zakres i źródła

- Kontynuacja PR #45; nie merge #23 do main.
- Jedna grupa `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/`, dokładny
  `sourceId=lodzsprzedazzakupwynajem`, max 20 postów, ekran włączony i pierwszy plan.
- Silnik odczytu: sprawdzony na Samsungu Gecko 0.5.7 + korekta obrazów 0.5.8.
- Transport/recovery: istniejący Watcher 0.7, PR #23, commit
  `8f2e4eada2360a2a30b6d463680de67817361847`. Do ponownego użycia bez drugiego importera:
  `collector/CollectorSigner.kt`, `SignedCollectorClient.kt`, `AndroidQueueSession.kt`,
  `CompletionOutbox.kt`, `EncryptedCompletionStorage.kt` oraz istniejące receipt i API.
- Kontrakt: `docs/facebook-android-backend-contract.md` w przypiętym PR #23.
  Historyczne CI tego komponentu nie jest nowym testem Gecko → API → baza.

## Dostarczony kod przygotowawczy

`../app/src/test/java/pl/jakubokruszek/flipwatcher/geckopoc/pilot/PilotBatchGate.kt` jest kompilowany WYŁĄCZNIE przez testy JVM, nie trafia
w APK lokalnego POC. Tworzy niemutowalny snapshot batcha pasującego do istniejącego
`SignedCollectorClient.prepareCompletion`, nie podpisuje ani niczego nie wysyła.
Wymaga nowej, jednorazowej zgody na przekazanie treści źródłowej i metadanych mediów,
potwierdzonego środowiska nieprodukcyjnego, ekranu i pierwszego planu. Zgoda trwa
<=60 s i zużywa się również przy błędnym wejściu. Brak automatycznego wznowienia.

Sprawdza konsumenta ANDROID_WEBVIEW (nazwa kontraktu, nie wymóg silnika WebView),
typ SOURCE_SCAN, DATA_ONLY, źródło, UUID zadania/lease i termin, dokładne post ID/
permalinki, brak duplikatów, max 20, prawdziwe pola źródła/author/text i datę <=72 h.
Nie zamienia DesktopRow ani ceny/metrażu w rzekomą źródłową treść. Akceptuje wyłącznie
rekordy z dowodem STRUCTURED_EXACT_STORY_ROOT z istniejącego kolektora. Inne dowody
pozostają zablokowane w tej pierwszej wersji. Media wymagają exactAssociation /
exactPostId i dozwolonego HTTPS origin. Nie kopiuje cookies/tokenów/dodatkowych pól.
Zachowuje rzeczywiste liczniki health, nie wylicza widoczności z liczby rekordów;
kompletność zawsze niepotwierdzona. Snapshot redaguje toString i nie zapisuje danych.

Testy JVM: zgody/ekran/kontekst, zużycie zgody, lease/źródło, brak prawdziwych pól
w kartach podglądu, daty, fałszywe ID, duplikaty/21 rekordów, media, health oraz
niemutowalność snapshotu. To test granicy przygotowania, nie wysyłki/receiptu.

## Docelowa ścieżka pilota do podłączenia

1. Osobny profil/instalacja pilota i osobne parowanie ANDROID_WEBVIEW w istniejącym
   nieprodukcyjnym środowisku; zero odczytu/usuwania danych działającego OFFLINE_TEST.
   Nie kopiować tokenu przeglądarki ani produkcyjnego service role do aplikacji.
2. Jawna nowa zgoda operatora: sesja Facebooka, konkretna grupa i źródłowe pola
   przekazywane do tego środowiska. Stare zgody na podgląd/skan nie uprawniają do tego.
3. Istniejący AndroidQueueSession: najpierw odzyskanie zaszyfrowanego outboxa, potem
   claim wyłącznie przypisanego jednego source registry UUID. Registry id nie jest
   Facebook sourceId. Jeden wykonawca i jeden browser, heartbeat 45 s / lease 180 s.
4. Oddzielny, zatwierdzony kanał Gecko dla pełnych rekordów pinned collector-core.
   Obecny podgląd przekazuje tylko wybrane pola; tej granicy nie wolno potajemnie
   rozszerzyć. Domyślnie ten nowy kanał OFF. PilotBatchGate kontroluje wynik.
5. SignedCollectorClient.prepareCompletion nadaje completionId raz. CompletionOutbox
   zapisuje dokładne body synchronicznie w EncryptedCompletionStorage PRZED wysłaniem.
   HMAC z istniejącego CollectorSigner, nowy nonce przy każdym HTTP retry, te same
   completionId/body przy niepewnej odpowiedzi. Receipt i lokalny stan trwale zapisane
   PRZED usunięciem outboxa; przy braku dowodu nie uruchamiać nowego skanu.
6. Istniejący backend data-only: brak Vision, galerii, pobierania zdjęć, screenshotów
   i importu do produkcyjnego Findera. Brak nowej bazy/usługi; tylko zweryfikowane
   istniejące testowe Render/Supabase. Nie wykonywać migracji/deploymentu w tym zadaniu.

## Warunki dopuszczenia — jeszcze NIE wykonane

- Wskazanie i niezależne potwierdzenie istniejącego testowego origin/profilu;
  nie zgadywać URL i nie wyciągać tokenów z dotychczasowego OFFLINE_TEST.
- Podłączenie powyższego kanału pełnych rekordów i niezmienionego transportu 0.7
  w osobnym pilocie; aktualny APK 0.5.8 nie ma endpointu ani funkcji wysyłania.
- Nowy łączny test lokalny Gecko → HMAC API → izolowany PostgreSQL: utrata sieci,
  utrata odpowiedzi po commit, restart procesu, fencing/lease, replay i zero duplikatów.
  Stare PASS PR #23 nie potwierdzają tej połączonej ścieżki.
- Osobne zatwierdzenie pierwszej prawdziwej sesji/próby przez operatora na telefonie.
  Bez merge/deploymentu, aktywowania produkcyjnych flag i zmian produkcyjnego Supabase.

Pilot jest więc przygotowany do przeglądu technicznego, ale **NIE GOTOWY do pierwszej
wysyłki**. Braki powyżej są rzeczywistymi pracami, nie domyślnym zezwoleniem ani
powodem do zgadywania danych. Następny etap implementacji ma je zamknąć przed testem
operatora. Ekran off/nocna automatyzacja pozostają osobnym etapem po pilocie on-screen.
