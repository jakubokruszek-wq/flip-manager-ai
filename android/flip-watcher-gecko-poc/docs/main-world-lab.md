# Port transportu desktopowego — laboratorium MAIN

Cel: rozstrzygnąć w rzeczywistym GeckoView 158, czy oficjalny MAIN/document_start
pozwala zainstalować hook fetch/XHR przed pierwszym inline skryptem strony.
To eksperyment automatyczny, nie nowa wersja aplikacji do testu Facebooka.

Oddzielne rozszerzenie main-lab@flip-manager.local, generowane wyłącznie dla
wariantu debug i instalowane wyłącznie przez test instrumentowany. PocActivity
nie instaluje go ani nie udostępnia przycisku. Manifest produkcyjnego POC,
zgody, filtry odpowiedzi, historia/outbox/limit skanu i wersja aplikacji bez zmian.
Release nie zawiera rozszerzenia laboratoryjnego.

Manifest lab: tylko http://127.0.0.1/groups/*, top-frame, MAIN document_start +
izolowany most native messaging. Brak Facebook/CDN, storage, cookies, webRequest,
background service worker, payloadów żądań, nagłówków, backendu i uploadu.
Wspólny core bundlowany z tego samego pliku, z tą samą kontrolą SHA-256.

Hook jest ograniczonym portem MECHANIZMU desktopowego, nie kopią całego rozszerzenia.
Fetch zachowuje oryginalny Response i czyta klon; XHR obserwuje load/responseText.
Lab endpoint musi mieć ten sam origin i dokładne /ajax/main-lab/?fixture=main-world-data.
Zgoda laboratoryjna: świeży UUID nadany przez JUnit przed loadUri + jawna flaga
labConsent=once. Bez niej wrappery nie czytają żadnych treści. Parametry te
NIE stanowią rozwiązania zgody/autoryzacji dla Facebooka ani przyszłego produktu.

Ograniczenia: 512 KiB/body, 1 MiB łącznie, do 4 odpowiedzi, 20 ID. Strumień
kopii fetch limitowany przed dekodowaniem. XHR używa już zbuforowanego responseText.
Dokładny grupowy permalink, deduplikacja, pola heurystyczne. STOP/visibilitychange/
pagehide unieważniają epoch, zerują liczniki/ID i odrzucają spóźnione wyniki.
Nie zmieniamy navigator.sendBeacon i nie próbujemy odczytu jego odpowiedzi.

Most window.postMessage emituje tylko 15 liczników, bez rekordów, ID, tekstów,
adresów lub nagłówków. Jest świadomie PUBLICZNYM mostem lokalnego testu, nie
zaufanym kanałem danych produkcyjnych. Strona może sfałszować liczniki; wyniki
lokalnego fixture nie uprawniają do przyjęcia takich zdarzeń z Facebooka.

Test instrumentowany:
- instalacja w prawdziwym GeckoView, nie symulacja Node;
- pierwszy inline skrypt potwierdza obecność hooka przed document_idle;
- bez zgody fetch/XHR otrzymują swoje dane, ale hook ma 0 bajtów i 0 ID;
- po świeżej zgodzie dwie początkowe odpowiedzi: fetch+XHR, 1 wspólne dokładne
  ID i deduplikacja, sygnały ceny/metrażu;
- zachowanie danych otrzymanych przez stronę w obu transportach;
- STOP usuwa wynik, nowy dokument bez zgody nie dziedziczy odczytu;
- uninstall lab w finally. Bez Facebooka, logowania i realnego skanu.

Node: 6 dodatkowych regresji manifestu/izolacji, zgody, transportu, deduplikacji,
obcych źródeł, przerwania, późnych wyników, limitu strumienia i fałszywych ID.
CI uruchamia również wszystkie dotychczasowe zestawy. Wynik emulatora i werdykt
zostają opublikowane w PR #45; PASS Node nie zastępuje wyniku MAIN na emulatorze.

Nawet PASS emulatora nie potwierdzi postów Facebooka: Samsung dotychczas
pokazywał Beacon, nie fetch/XHR, a hook desktopowy też nie czyta Beacon.
Nie prosimy o instalację kolejnego APK na podstawie samych liczników.
Następny krok produktowy wymaga osobnej zgody UI, prywatnego kanału sterowania,
wiążącego kontekstu/karty, deadline i weryfikacji bezpieczeństwa bez zaufania
publicznym zdarzeniom strony. Produkcyjny LIVE pozostaje wyłączony.
