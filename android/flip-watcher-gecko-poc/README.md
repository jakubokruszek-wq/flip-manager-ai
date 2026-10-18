# Flip Watcher — Gecko POC

Osobny prototyp Androida, który odpowiada na jedno pytanie:
**czy GeckoView potrafi odczytać posty osobno zatwierdzonej grupy `lodzsprzedazzakupwynajem` po ręcznym zalogowaniu?** Pierwotna grupa `402796264871862` nie jest traktowana jako alias tej grupy.

Osobny pakiet `pl.jakubokruszek.flipwatcher.geckopoc`, więc instaluje się **obok** dotychczasowego Watchera/Collectora, niczego z nim nie dzieli i nie nadpisuje.

## Co jest w środku

| Część | Plik | Uwagi |
|---|---|---|
| Przeglądarka | `PocActivity.kt` | GeckoView z domyślnym User-Agentem Firefoksa (bez nadpisywania). Sesja otwierana dopiero po zgodzie operatora. Tylko adresy `*.facebook.com`; inne przejścia są blokowane i liczone w diagnostyce. Zasoby strony **nie są filtrowane** (w przeciwieństwie do pilota WebView), więc strona ładuje się jak w zwykłej przeglądarce. |
| Zasady | `PocPolicy.kt` | Jedna zatwierdzona grupa; STOP przy checkpoint/CAPTCHA/logowaniu/innej grupie; czyszczenie adresów z parametrów (tokeny nie trafiają na ekran). |
| Rozszerzenie wbudowane | `src/main/extension/` + `collector-core.js` | `collector-core.js` jest kopiowany przy budowie z `extensions/facebook-collector/` **bez zmian**; build sprawdza jego SHA-256 (`32c98525…`, ten sam co w PR #44). Nie powstał drugi parser: `poc-adapter.js` wywołuje `parsePostLink`, `extractStructuredRecordsFromText`, `mergeRecords` z core. |
| Kanał | `CollectorChannel.kt` | Oficjalny native messaging GeckoView (`connectNative` + `Port`). Port przyjmowany tylko z górnej ramki Facebooka. Zmiana strony zamyka port, więc skan w toku kończy się `PORT_CLOSED`. |
| Walidacja | `ScanProtocol.kt` | Aplikacja ponownie sprawdza każdy wynik: tylko cyfrowe ID z dokładnym kanonicznym linkiem zatwierdzonej grupy, bez duplikatów, maksymalnie 20; status STOP nigdy nie niesie postów. |
| Wyniki | `PocResultStore.kt` | Jeden plik JSON w prywatnym katalogu aplikacji (`files/gecko-poc/`). Tylko ID, linki i liczniki: bez treści, autorów, zdjęć, cookies i tokenów. **Nic nie jest wysyłane**, bo POC nie ma żadnego klienta sieciowego (pilnuje tego `scripts/isolation-check.sh` w CI). |
| Etap C | `ScreenOffTest.kt`, `HeadlessFixtureScan.kt` | Test wyłącznie na lokalnym HTML (serwer na 127.0.0.1). Patrz [docs/etap-c-wygaszony-ekran.md](docs/etap-c-wygaszony-ekran.md). |

## Instalacja na Samsungu S25 FE

1. Otwórz na telefonie GitHub → zakładka **Actions** → workflow **„Android Flip Watcher Gecko POC”** → najnowszy zielony przebieg na gałęzi `claude/facebook-watcher-mobile-gq36l8`.
2. W sekcji **Artifacts** pobierz `flip-watcher-gecko-poc-arm64-<numer>` (zip). Pobieranie artefaktów wymaga zalogowania do GitHuba.
3. Rozpakuj zip (aplikacja *Moje pliki*). W środku jest `app-arm64-v8a-debug.apk` (około 70–90 MB) i plik z wersją GeckoView.
4. Stuknij APK. Jeśli Android zapyta, zezwól *Moje pliki* na „Instalowanie nieznanych aplikacji”. Play Protect może ostrzec o aplikacji testowej (podpis debug): wybierz „Zainstaluj mimo to”.
5. Na liście aplikacji pojawi się **„Flip Watcher — Gecko POC”** (osobno od dotychczasowego Watchera).

## Ręczny test logowania i grupy (Etap A + B)

Test robisz Ty, na własnym koncie. Aplikacja niczego nie klika i nie wypełnia za Ciebie.

1. Otwórz aplikację i stuknij **„Otwórz sesję”**. Przeczytaj zgodę i stuknij **„Zgadzam się”**. Otworzy się zatwierdzona grupa.
2. W dolnym panelu diagnostyki sprawdź:
   - `User-Agent` zawiera `Firefox/…`;
   - `UA zawiera „; wv”: false`;
   - `rozszerzenie: zainstalowane`.
3. Stuknij **„Zaloguj się”**. Powinna się pojawić **oficjalna strona logowania Facebooka**. W diagnostyce linia `DOM (…/login…)` powinna pokazać `formularze ≥ 1`, `pola ≥ 2`, `hasła 1`. To jest bezpośrednie porównanie z białą stroną w WebView (tam było 0/0/0).
4. Zaloguj się normalnie (e-mail, hasło, ewentualnie 2FA). Jeśli Facebook pokaże **checkpoint lub CAPTCHA**:
   - aplikacja wyświetli czerwony **STOP**, a skan zostanie zablokowany;
   - weryfikację możesz dokończyć ręcznie albo stuknąć „Zamknij sesję”;
   - nic nie jest rozwiązywane automatycznie.
5. Stuknij **„Wróć do grupy”**. Jeśli zamiast tego pojawi się STOP `OTHER_GROUP`, stuknij **„Diagnoza grupy”** (sekcja niżej) i przyślij wynik. Banner powinien pokazać „Zatwierdzona grupa otwarta”, a w GeckoView powinny być widoczne posty.
   - ✅ **GO A**: zalogowałeś się i widzisz posty grupy.
6. Stuknij **„Skanuj widoczne”**. Odczytywany jest tylko ekran, bez przewijania, maksymalnie 20 postów w 45 s. Wynik pokazuje status, liczbę postów i listę `ID [źródło] link`.
   - Opcjonalnie: **„Skanuj + przewiń 3×”** (3 spokojne przewinięcia co 1,5 s).
7. Porównaj 2–3 ID z rzeczywistymi postami: otwórz link z wyniku w zwykłym Facebooku.
   - ✅ **GO B**: prawdziwa liczba postów, poprawne ID, brak duplikatów.
8. Zrób zrzut ekranu panelu diagnostyki i wyniku (bez danych osobowych na ekranie GeckoView, jeśli to możliwe).
9. Na koniec stuknij **„Zamknij sesję”** albo **„Wyloguj i usuń dane”**, który usuwa cookies i dane stron tej aplikacji.

Jeśli w kroku 3 formularz **nie** pojawi się także w GeckoView, przyślij zrzut diagnostyki. Zgodnie z kryterium nie rozwijamy wtedy automatyzacji bez ponownej oceny.

## Adres tekstowy grupy (OTHER_GROUP)

Na Samsungu GeckoView pokazał `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/` zamiast `…/groups/402796264871862/`. **Ten alias nie jest potwierdzony**, więc skan pozostaje zablokowany (STOP `OTHER_GROUP`):
- w repozytorium obie formy są **dwoma oddzielnymi zatwierdzonymi źródłami** (`extensions/facebook-collector/background.js`, lista źródeł w PR #44);
- test `collector-core.test.cjs` wiąże ten slug z **innym** numerem: `1350200629551011`;
- mapowanie historyczne w PR #44 opisuje `402796264871862` jako „Nieznana grupa”;
- z serwera CI nie da się otworzyć Facebooka, więc nie było jak potwierdzić powiązania z zewnątrz.

Mechanizm aliasu jest gotowy, ale wyłączony: `PocPolicy.VERIFIED_ALIASES` jest pusta. Alias dopuszcza dokładnie jeden slug dla jednego numeru, nigdy dowolną ścieżkę `/groups/`. Tożsamość postów zawsze pozostaje numeryczna, a karty z linkiem do innej grupy są odrzucane.

**„Diagnoza grupy”** zbiera na telefonie dowód, który podaje sam Facebook:
- numer grupy z metadanych app-link strony (`al:android:url`, `al:ios:url`);
- łańcuch przejść: czy Facebook sam, bez kliknięcia, zmienił adres numeryczny na tekstowy.

Możliwe wyniki:

| Wynik | Znaczenie | Co dalej |
|---|---|---|
| `DOWÓD ALIASU` | Oba warunki spełnione | Przyślij wynik. Alias zostanie dodany ręcznie w kolejnej wersji, po Twojej zgodzie. |
| `INNA GRUPA` | Facebook podaje inny numer | STOP zostaje; trzeba wrócić do grupy albo zatwierdzić nowe źródło. |
| `BRAK DOWODU` | Za mało danych | STOP zostaje. |

Nazwa, tytuł i zdjęcie grupy nigdy nie są dowodem. Wynik diagnozy zapisuje się też w „Wyniki”.

## Podpis i aktualizacje

Od wersji 0.1.1 APK jest podpisywany stałym, **publicznym** kluczem testowym `app/gecko-poc-debug.keystore` (to nie jest sekret i nie służy do wydań w sklepie). Certyfikat SHA-256: `878b11e677eb4a62883b0b8709fa19c969926708053a01d47f01b0548fb370a2`; CI sprawdza go przy każdym buildzie. Każda następna wersja instaluje się więc jako aktualizacja.

Wersje 0.1.0 były podpisane losowym kluczem każdego serwera CI, dlatego **jednorazowo** trzeba odinstalować 0.1.0 przed instalacją 0.1.1. Odinstalowanie usuwa też sesję Facebooka tej aplikacji, więc potrzebne będzie ponowne logowanie.

## NO_POSTS na Samsungu: przyczyna i poprawka (0.2.0)

**Co pokazała diagnostyka 0.1.5:**
- grupa `GROUP_OK`;
- `[role=article]` 0, `<article>` 0, `[role=feed]` 0;
- 5 linków `<a>`, 0 permalinków;
- 0 skryptów `application/json`, 0 iframe, 0 Shadow DOM;
- a posty są widoczne.

**Przyczyna (z kodu).** Adapter 0.1.x szukał ID posta tylko w trzech miejscach: w linkach `<a href>` wewnątrz `[role=article]/<article>` oraz w `script[type="application/json"]`. Mobilny Facebook pokazany w GeckoView żadnego z nich nie używa. Posty to drzewa `div`, a przejście do posta obsługuje JavaScript, nie link. Dlatego skan zwracał `NO_POSTS`, mimo że posty są na ekranie.

Inne hipotezy wykluczone:
- **Inny dokument:** skrypt czyta `document` na żywo przy każdym zapytaniu i nie trzyma starych referencji.
- **Iframe i Shadow DOM:** oba 0.
- **Inne drzewo DOM w rozszerzeniu:** Firefox daje rozszerzeniom ten sam DOM (Xray), ukrywa tylko obiekty JavaScript strony.

**Poprawka.** Dokładne ID są teraz brane przez niezmieniony `collector-core.js` z danych, które Facebook sam dostarcza tej sesji:
1. ze **zwykłych skryptów inline** strony, nie tylko `application/json`;
2. z **odpowiedzi sieciowych sesji** (`webRequest.filterResponseData`), tak jak `network-hook.js` w produkcyjnym rozszerzeniu Chrome:
   - odpowiedź trafia do strony bez zmian;
   - kopia zostaje wyłącznie w pamięci rozszerzenia, osobno dla każdej karty i bieżącego dokumentu, maksymalnie 20 min;
   - na zewnątrz wychodzą tylko ID i kanoniczne permalinki, które core powiązał z grupą.

ID jest przyjmowane tylko wtedy, gdy ten sam węzeł danych zawiera **permalink tej grupy**. Komentarze, udostępnienia z innych grup, `fbid` zdjęć i ID bez permalinku są odrzucane. Walidacja w aplikacji, limit 20 i deduplikacja bez zmian.

**„Diagnoza postów”** (dawne „Sprawdź DOM”) tylko liczy i nie zużywa zgody na skan. Rozróżnia:
1. dokument i kontekst (czy punkty ekranu należą do czytanego dokumentu);
2. znaczniki (`article`, `data-mcomponent`, `data-tracking-duration-id`, obrazy…) oraz 15 najczęstszych NAZW atrybutów;
3. permalinki w `<a>` i w innych atrybutach;
4. zmiany DOM (MutationObserver) i podejrzenie wirtualizacji listy;
5. klucze ID i **dokładne ID** w danych strony;
6. to samo w sieci.

Wynik to jeden z kodów: `EXACT_IDS_AVAILABLE`, `ID_KEYS_WITHOUT_EXACT_BINDING`, `NO_POST_IDS_IN_PAGE_DATA`, `NETWORK_NOT_OBSERVED_YET`, `NO_POST_MARKUP`, `WRONG_DOCUMENT_OR_CONTEXT`.

Testy CI używają lokalnych stron wzorowanych na mobilnym Facebooku (`mobile-div-*`). **Nie są dowodem działania na prawdziwym Facebooku**: to rozstrzyga dopiero diagnoza na Samsungu.

## Testy

- `node --test app/src/test/js/poc-adapter.test.cjs`: adapter nad niezmienionym `collector-core.js`.
- `./gradlew testDebugUnitTest`: zasady, protokół, magazyn, serwer fixture (JVM).
- `./gradlew connectedDebugAndroidTest`: prawdziwy GeckoView na emulatorze. Tylko lokalne strony z `assets/fixtures/`; **żaden test nie otwiera Facebooka**.
- CI: `.github/workflows/android-gecko-poc.yml`, czyli izolacja, testy core, kompilacja, APK z weryfikacją podpisu i rozszerzenia oraz testy na emulatorze Androida 16.

## POC 0.1.5 — diagnostyka ramek i otwartego Shadow DOM

Wersja 0.1.4 potwierdziła na fizycznym Samsungu, że pomimo widocznych ogłoszeń na zatwierdzonej grupie `lodzsprzedazzakupwynajem` dokument główny widziany przez rozszerzenie zawiera tylko **5 linków**, **0 kart article**, **0 identyfikatorów postów**, **0 skryptów JSON**. Nie można z tego wyciągać wniosku, że grupa nie zawiera postów.

Ręczny przycisk `Sprawdź DOM` dodatkowo pokazuje liczby ramek `iframe`, ramek dostępnych dla skryptu i ramek niedostępnych, liczby linków i artykułów wewnątrz dostępnych ramek oraz liczby otwartych korzeni Shadow DOM i ich linków/kart. Te dodatkowe liczniki **nie przesyłają URL, tekstów, ID ani zawartości strony** i nie służą do tworzenia postów. Nie zmieniono `all_frames: false`, nie włączono skanowania ramek ani obejść ograniczeń origin.

Zainstaluj APK 0.1.5 jako aktualizację 0.1.4, otwórz zatwierdzoną grupę, przewiń do kilku ogłoszeń, naciśnij `Sprawdź DOM` i prześlij dolny raport. **Nie resetuj jednorazowej zgody i nie uruchamiaj skanu.** Pełny kolektor poprawiamy dopiero po ustaleniu, gdzie jest struktura postów.

## POC 0.1.4 — diagnostyka mobilnego DOM bez zużywania skanu

Dodano przycisk **Sprawdź DOM**. Na aktualnej, dokładnie zatwierdzonej grupie przycisk ręcznie odświeża stan DOM w GeckoView i raportuje jedynie zagregowane liczby: elementy `[role=article]` / `article`, kontenery `role=feed`, linki HTML, linki do postów zatwierdzonego źródła, unikalne numeryczne identyfikatory wynikające z tych linków, obce linki grup, odnośniki do zdjęć oraz kontenery strukturalne. Żadne adresy, identyfikatory, treści, hasła ani cookies nie opuszczają rozszerzenia w ramach tej funkcji. Dane te nie są zapisywane do historii ofert ani wysyłane do serwera.

Przycisk nie wywołuje `scan()`, nie przewija strony, nie resetuje jednorazowego limitu i nie przyznaje zgody na następny skan. Diagnostyka działa tylko na `lodzsprzedazzakupwynajem`. Zero oznacza brak **potwierdzonej struktury w DOM**, a nie brak postów na stronie. Na wcześniejszym fizycznym Samsungu wizualnie były posty, a selektory `article` / `[role=article]` pokazywały zero; potrzebne są nowe pomiary przed modyfikacją ekstrakcji.

**Instalacja:** APK 0.1.4 jako aktualizacja istniejącego Gecko POC; nie odinstalowuj i nie czyść danych. Otwórz zatwierdzoną grupę, przewiń do widocznych postów i dotknij `Sprawdź DOM`. Prześlij wyłącznie liczby z dolnego panelu. Niczego nie skanuj.

## POC 0.1.3 — trwały dziennik próby i uczciwy status

Jednorazowa zgoda jest utrwalana razem ze statusem STARTED PRZED wysłaniem żądania. Odmowa zapisu początku próby oznacza NO_REQUEST_SENT, bez wywołania rozszerzenia. Wynik i jego liczniki są zapisywane w lokalnym magazynie oraz podsumowaniu SharedPreferences; błąd zapisu jest jawnie wyświetlany. W "Wyniki" próby GROUP_SCAN są prezentowane przed rozbudowaną historią diagnoz. Po restarcie niedokończony STARTED pozostaje niepotwierdzony, a nie zaliczony jako sukces.

**Ważne:** próba wykonana w 0.1.2 miała wyłącznie flagę zużytej zgody. Aktualizacja nie może odtworzyć jej wyniku; pokazuje "poprzednia próba — brak zapisanego statusu". Nie usuwa danych, nie resetuje zgody i nie uruchamia kolejnego skanu. Osobna zgoda będzie konieczna do następnej próby. APK 0.1.3 można zainstalować nad 0.1.2 z zachowaniem lokalnej sesji.

## POC 0.1.2 — osobno zatwierdzone źródło (jeden skan)

Operator wyraźnie zatwierdził **wyłącznie** `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/` jako samodzielne źródło do JEDNEGO ręcznie uruchomionego testu maksymalnie 20 postów. Identyfikator `402796264871862` i wszelkie inne grupy pozostają niedozwolone; **nie dodano żadnego aliasu**. Kanoniczny link posta musi zawierać dokładnie ten zatwierdzony segment grupy i numeryczny identyfikator posta. Znane obce linki są odrzucane; nigdy nie dopasowujemy po podobnej nazwie grupy.

Kliknięcie `Skanuj widoczne` lub `Skanuj + przewiń 3×` **zużywa jedną zgodę przed uruchomieniem**. Stan pozostaje zachowany między restartami i aktualizacjami; ponowny test wymaga osobnego zatwierdzenia i nowej wersji. Nie wykonuj automatycznego skanowania, testu nocnego na Facebooku ani transferu do Findera. Wyniki pozostają wyłącznie w prywatnej pamięci aplikacji. Pole `Diagnoza grupy` może służyć do kontroli, ale nie nadaje żadnych dodatkowych uprawnień.

**Instalacja 0.1.2:** ZIP z najnowszego przebiegu CI PR #45, rozpakowanie `app-arm64-v8a-debug.apk`, instalacja jako **aktualizacja** 0.1.1 (ten sam certyfikat testowy); nie odinstalowuj działającego Gecko POC, aby zachować sesję. Po wejściu na dokładny adres grupy zaczekaj na `Zatwierdzona grupa otwarta`, a dopiero potem uruchom jeden skan.
