# Watcher 0.7 → ręczny pilot jednej grupy (Issue #43)

Status: przygotowanie, LIVE OFF. Brak logowania, kontaktu testów z Facebookiem,
wdrożenia, migracji, aktywacji produkcji lub testu na fizycznym Samsungu.

## Baza i zakres

Main: `952b4964c329dccbb1b5ace0bae6e75b026db3ae`; PR #23:
`8f2e4eada2360a2a30b6d463680de67817361847`; wspólna baza:
`642fdf3301d08cd0151526625bd05ced3bc2fd43`. PR #23 jest 37 commitów
do przodu i 110 do tyłu. Przeniesiono jego pliki Watchera na main przez
porównanie trzech drzew, bez cofania nowszych zmian Findera/OLX/Radaru/Deal Room.
Nie scalono #23 ani niniejszego PR. Historyczne wyniki #23 są w
[raporcie 0.7](facebook-android-0.7-validation.md); nie są wynikami nowego kodu.

## Implementacja

`WebViewCollectorBrowser` + `LivePilotChannel`: jeden widoczny WebView,
systemowy User-Agent, `addWebMessageListener`, dokładny HTTPS origin, główna
ramka, URL grupy i losowy nonce każdego skanu. Brak `addJavascriptInterface`.
Kolektor rozszerzenia jest kopiowany bez zmian i sprawdzany SHA-256:
`32c98525cfac6b580b93b4847140d4872ee4119b26981786322235df42e5b88b`.
Adapter używa istniejącego ekstraktora tożsamości i zdjęć; DOM bez dowodu
pozostaje UNVERIFIED. Maks. 20 postów, 45 s, 512 KiB wiadomości, snapshot
widocznej strony bez przewijania, galerii, pobierania zdjęć ani Vision.
Snapshot nie gwarantuje znalezienia 20 postów ani zgodności z każdym layoutem FB.

Sesja i skan mają osobne, nieutrwalane zgody. Każde przejście aplikacji w tło
anuluje skan; wygaszenie ekranu jest monitorowane i nadal blokuje start.
Login, checkpoint, CAPTCHA, 403, redirect, brak grupy, brak dokładnej
tożsamości i utrata renderera kończą próbę STOP. Operator sam obsługuje
interaktywny login wyłącznie po udzieleniu osobnej zgody na sesję.
Nie ma automatycznego rozwiązywania challenge ani nocnego LIVE WorkManagera.

Wysyłka korzysta z `AndroidQueueSession`, HMAC/nonce, heartbeat/lease/fencing
i `CompletionOutbox`. Osobny zaszyfrowany journal `LIVE_PILOT_43` utrwala claim,
completion przed wysyłką i receipt przed usunięciem completion. Ponowienie
potwierdzenia nie otwiera FB. Śmierć procesu przed enqueue kończy pierwotny
claim jako przerwany; brak automatycznego wznowienia skanu. Utracony lease
wymaga uzgodnienia na testowym backendzie, bez kasowania lokalnego journalu.
Eksport diagnostyki zawiera tylko statusy, czasy i liczniki, bez profilu,
klucza, body, URL, identyfikatorów postów i treści.

## APK i telefon bez PC — etap przygotowawczy

Workflow `Facebook LIVE pilot preparation (no Facebook access)` tworzy artifact
`flip-watcher-pilot43-safe-off-<commit>`, APK, SHA-256 i odcisk certyfikatu.
Pakiet: `pl.jakubokruszek.flipcollector.integration.pilot43`.
Jest inny od produkcji, `.integration` i `.remote2`. Nie odinstalowywać żadnej
dotychczasowej aplikacji, nie czyścić danych i nie zastępować starych APK.
Podpis debug nowego pakietu nie zapewnia aktualizacji kolejnych buildów;
przy konflikcie certyfikatu STOP, bez usuwania aplikacji i danych.

1. Na Samsungu otwórz Draft PR → Checks → powyższy workflow → Artifacts.
2. Pobierz ZIP, rozpakuj w „Moje pliki”, porównaj SHA-256 i identyfikator.
3. Zainstaluj tylko osobne APK „Flip Watcher · pilot 43”. Jeżeli Android pyta
   o aktualizację istniejącej aplikacji, przerwij i zweryfikuj pakiet/podpis.
4. Otwórz Facebook Watcher → „Test LIVE — 1 grupa (pilot)”. Oczekiwany stan:
   blokada pilota, brak sesji FB. Bez logowania i bez skanu.
5. Sprawdź osobno, że dotychczasowy OFFLINE_TEST ma niezmienioną historię,
   outbox i receipts. Nowa instalacja ma własny sandbox; niczego nie importuje.

## Osobna zgoda i warunki dopuszczenia do pierwszego LIVE — etap A

Bez kolejnej zgody zatrzymać się tutaj. Domyślne flagi
`LIVE_COLLECTION_ENABLED`, `ANDROID_BACKEND_INTEGRATION_ENABLED`,
`LIVE_PILOT_ENABLED` pozostają false. Bieżące APK nie otworzy Facebooka.

Warunek przed dopuszczeniem: dedykowane, zatwierdzone HTTPS API bez zapisu do
produkcyjnego Findera, jedna grupa GROUP oraz grant dla osobnego urządzenia,
krótkotrwały profil i jawne zatwierdzenie konkretnej grupy i sesji.
Istniejący Render OFFLINE_TEST przyjmuje **wyłącznie OFFLINE_TEST** i nie jest
gotowym endpointem LIVE. Nie zmieniać jego trybu, bazy, źródeł ani historii.
Nie podawać do pilota produkcyjnego originu, tokenu ani konfiguracji filtrów.
Obecna implementacja klienta używa istniejącego kontraktu LIVE; wydanie buildu
z flagą true wymaga wcześniej zweryfikowanego izolowanego odbiornika tego
kontraktu i oddzielnej zgody na jego konfigurację/wdrożenie. Sam adres inny
niż produkcyjny nie dowodzi izolacji bazy — operator musi to zweryfikować.

Po spełnieniu warunków można osobno zatwierdzić build DEBUG z
`-PFLIP_PILOT_APK=true -PFLIP_LIVE_PILOT_ENABLED=true`
`-PFLIP_LIVE_PILOT_ORIGIN=https://zatwierdzony-testowy-origin`.
Nigdy nie ustawiać produkcyjnego LIVE ani integracji Findera.
Profil (przekazać prywatnie, nie w PR/logach):

```json
{
  "version": 1, "purpose": "LIVE_PILOT", "dataMode": "LIVE", "maxPosts": 20,
  "origin": "https://zatwierdzony-testowy-origin",
  "deviceId": "<UUID osobnego urządzenia>", "deviceToken": "<43 znaki base64url>",
  "expiresAt": 0,
  "source": {"id": "<UUID grantu źródła>", "sourceId": "<id grupy>",
    "url": "https://www.facebook.com/groups/<id grupy>/"}
}
```

`expiresAt`: przyszły timestamp ms, maks. 1 godzinę. Odbiornik musi mieć tę
samą izolację/grant i wyłączone Vision. Kontrakt HMAC i przygotowanie grantu:
[istniejący kontrakt](facebook-android-backend-contract.md). Nie uruchamiać
migracji w produkcyjnym Supabase.

Fizyczny test A: Samsung Galaxy S25 FE, zapisać wersje Androida 16, One UI,
WebView, APK i SHA. Wi-Fi, ładowarka, ekran włączony, aplikacja na pierwszym
planie. Zapisać stan OFFLINE_TEST przed próbą. Po zgodzie skonfigurować profil,
zatwierdzić sesję, wykonać login ręcznie, potwierdzić konkretną grupę i jeden
skan. Zweryfikować ≤20 postów, postId/permalink/źródło i zdjęcia, filtry
mieszkań/ceny/metrażu/dzielnicy, receipt i izolowane dane. Powtórzyć jedynie
potwierdzenie po utracie Wi-Fi/odpowiedzi; liczba rekordów nie może wzrosnąć.
Przycisk STOP i Home mają zatrzymać WebView, zachowując pending completion.
Każdy challenge/403 lub utrata lease: STOP i diagnoza bez ponownego skanu.

## Osobny test ekranu wygaszonego — etap B

Dopiero po dowodzie A i odrębnej decyzji operatora. Najpierw scharakteryzować
naturalne wygaszenie podczas zatwierdzonej próby: oczekiwany STOP i poprawny
receipt/recovery, bez domniemania pracy JS po blokadzie. Zebrać na fizycznym
telefonie czasy, heartbeat, stopReason, temperaturę, stan Wi-Fi/ładowarki,
Doze/App Standby, opóźnienia istniejącego WorkManagera OFFLINE_TEST i stan
outboxa. Powtórzyć przy ładowarce i bez niej, po naturalnym Doze i przy
przerwaniu sieci. Nie usuwać SCREEN_OFF, nie wymuszać wake lock/FGS, nie
zmieniać zabezpieczeń systemu i nie symulować interakcji użytkownika.

Ten PR nie dostarcza nocnego LIVE. Jeżeli ekran off wstrzymuje renderer,
wspieranym trybem pozostaje jawny ręczny skan po odblokowaniu. OFFLINE_TEST
nocą oraz emulator nie stanowią dowodu działania Facebook WebView na Samsungu.

## Dowody testowe

Nowy JS adapter: lokalne fixture, pin core, limit/deduplikacja, challenge/STOP,
brak fikcyjnej oferty i cudzych zdjęć. JVM: origin/frame/source/nonce/payload,
media, limit, journal po restarcie i idempotentne receipts. Android 16:
rzeczywisty WebView/WebMessage na lokalnym HTML z wyłączoną siecią.
Istniejące CI: cały Kotlin/JVM, Android16, HMAC/API/PostgreSQL/outbox/replay,
TypeScript/ESLint/Next build, regresja Facebooka i pełny test schematu Findera.
Wyniki bieżącego commitu należy odczytywać z Checks Draft PR; historycznych
liczb testów z #23 nie doliczać do nowego dowodu. Fizyczny Samsung: NIE WYKONANO.
