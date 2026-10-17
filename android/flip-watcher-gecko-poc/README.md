# Flip Watcher — Gecko POC

Osobny prototyp Androida, który odpowiada na jedno pytanie:
**czy przeglądarka GeckoView (silnik Firefoksa) w naszej aplikacji pozwala normalnie zalogować się do Facebooka i odczytać posty grupy `402796264871862`?**

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

Od wersji 0.1.1 APK jest podpisywany stałym, **publicznym** kluczem testowym `app/gecko-poc-debug.keystore` (to nie jest sekret i nie służy do wydań w sklepie). Certyfikat SHA-256: `878b11e6…548fb370a`; CI sprawdza go przy każdym buildzie. Każda następna wersja instaluje się więc jako aktualizacja.

Wersje 0.1.0 były podpisane losowym kluczem każdego serwera CI, dlatego **jednorazowo** trzeba odinstalować 0.1.0 przed instalacją 0.1.1. Odinstalowanie usuwa też sesję Facebooka tej aplikacji, więc potrzebne będzie ponowne logowanie.

## Testy

- `node --test app/src/test/js/poc-adapter.test.cjs`: adapter nad niezmienionym `collector-core.js`.
- `./gradlew testDebugUnitTest`: zasady, protokół, magazyn, serwer fixture (JVM).
- `./gradlew connectedDebugAndroidTest`: prawdziwy GeckoView na emulatorze. Tylko lokalne strony z `assets/fixtures/`; **żaden test nie otwiera Facebooka**.
- CI: `.github/workflows/android-gecko-poc.yml`, czyli izolacja, testy core, kompilacja, APK z weryfikacją podpisu i rozszerzenia oraz testy na emulatorze Androida 16.
