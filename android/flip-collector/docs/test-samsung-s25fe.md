# Pierwsze testy na Samsungu Galaxy S25 FE (Android 16)

Wersja: Flip Collector 0.4.0, build debug (`pl.jakubokruszek.flipcollector.debug`, „Flip Collector (test)”).
Tryb: **DEMO** — Facebook nie jest otwierany, nic nie jest wysyłane do Flip Managera.

Wynik każdego kroku wpisz jako OK / BŁĄD / NIE WYKONANO. Nie wpisuj OK, jeśli krok nie był wykonany.

## 0. Instalacja

1. GitHub → Actions → „Android Flip Collector APK” → najnowszy zielony przebieg → artefakt `flip-collector-debug-…` → pobierz ZIP i rozpakuj `app-debug.apk`.
2. Zainstaluj APK. Telefon zapyta o zgodę na instalację z tego źródła.
3. Sprawdź, że wersja produkcyjna „Flip Collector” (jeśli jest) **nadal jest zainstalowana i ma swoje dane**. Test ma osobny identyfikator i osobną ikonę „Flip Collector (test)”.

## 1. Interfejs (ekran włączony)

| # | Krok | Oczekiwany wynik |
| --- | --- | --- |
| 1.1 | Otwórz aplikację → „Otwórz Facebook Watcher” | Zakładki Pulpit / Harmonogram / Grupy / Historia, baner „TRYB DEMO”. |
| 1.2 | Pulpit: plakietki urządzenia | Wi-Fi i ładowanie zgodne ze stanem telefonu, procent baterii. Zmień stan (odłącz ładowarkę, wyłącz Wi-Fi) — plakietki zmieniają się w ciągu ok. 5 s. |
| 1.3 | Czytelność | Tekst nie nachodzi na pasek stanu ani nawigacji; przyciski „Skanuj teraz” i „Zatrzymaj” łatwe do trafienia kciukiem. |

## 2. Skan demo

| # | Krok | Oczekiwany wynik |
| --- | --- | --- |
| 2.1 | „Skanuj teraz” (stan Wi-Fi, ładowarki i parowania bez znaczenia) | Pasek „Grupy 0/1”, pasek postów rośnie do 12/12, licznik ofert do 6, na końcu „Gotowy”. |
| 2.2 | Historia → „Testy demo” | Wpis „Ręczny · DEMO · Zakończony”, 12 postów, 6 ofert, „Wysłane do Flip Managera: 0”. Zakładka „Na żywo” pusta. Pulpit: „Wyniki Facebook Watchera (na żywo)” — brak; „Testy demo” — 1 test. |
| 2.3 | „Skanuj teraz”, po ok. 2 s „Zatrzymaj” | Wpis „Zatrzymany”, powód „Zatrzymane przez użytkownika”. |
| 2.4 | Harmonogram → „Symuluj błąd w skanie demo” → Pulpit → „Skanuj teraz” | Wpis „Błąd”: „Symulowany błąd po 7 postach (tryb demo)”. Wyłącz przełącznik po teście. |
| 2.5 | Telefon niesparowany, tryb samolotowy, bez ładowarki → „Skanuj teraz” | Skan demo rusza i kończy się normalnie (działa w pełni lokalnie). |
| 2.6 | Dwa szybkie stuknięcia „Skanuj teraz” | Uruchamia się jeden skan (przycisk wyłącza się po pierwszym). |

## 2a. Czytelność i motyw

| # | Krok | Oczekiwany wynik |
| --- | --- | --- |
| 2a.1 | Pierwsze uruchomienie | Jasne tło, grafitowy tekst, złote przyciski; ikony paska stanu ciemne i widoczne. |
| 2a.2 | Ustawienia telefonu → tryb ciemny włączony, aplikacja w motywie „Jasny” | Aplikacja zostaje jasna, wszystko czytelne. |
| 2a.3 | Harmonogram → Wygląd → „Systemowy”, przełączaj tryb ciemny telefonu | Aplikacja przełącza się między jasnym a ciemnym motywem; w obu tekst czytelny, ikony paska stanu kontrastowe. |
| 2a.4 | Harmonogram → Wygląd → „Ciemny” | Ciemne tło, jasny tekst; pola formularzy, przyciski, historia czytelne. |
| 2a.5 | Grupy → pola „Nazwa grupy” i „Link” | Etykiety, wpisywany tekst i obramowanie wyraźne w obu motywach. |

## 3. Harmonogram i automat (wymaga nocy albo zmiany okna)

| # | Krok | Oczekiwany wynik |
| --- | --- | --- |
| 3.1 | Harmonogram: domyślne ustawienia | Automat wyłączony, 02:00–05:00, wszystkie dni, Wi-Fi i ładowanie włączone. |
| 3.2 | Ustaw okno: teraz + 5 min do teraz + 60 min, włącz automat, ładowarka + Wi-Fi, zablokuj ekran | W ciągu ok. 15–30 min w Historii pojawia się „Automat · DEMO”. Zanotuj godzinę. Android może opóźnić zadanie — zapisz faktyczne opóźnienie. |
| 3.3 | Po wpisie z 3.2 poczekaj kolejne 30 min w tym samym oknie | Brak drugiego skanu; w diagnostyce `AUTO_TICK_WAIT` „okno już obsłużone”. |
| 3.4 | Okno przez północ (np. 23:30–00:30) | Skan w oknie; dzień rozpoczęcia decyduje. |
| 3.5 | Noc z domyślnym oknem 02:00–05:00, telefon na ładowarce, ekran wygaszony | Rano: wpis automatu z nocy albo w diagnostyce powód braku (np. `STOP_REASON_QUOTA`). Zapisz wynik bez interpretacji. |
| 3.6 | Samsung: Ustawienia → Aplikacje → Flip Collector (test) → Bateria: „Zoptymalizowana” vs „Bez ograniczeń” | Powtórz 3.2 w obu ustawieniach, porównaj opóźnienia. |

## 3a. Przerwanie i odzyskanie skanu

| # | Krok | Oczekiwany wynik |
| --- | --- | --- |
| 3a.1 | „Skanuj teraz”, po 1–2 s: Ustawienia telefonu → Aplikacje → Flip Collector (test) → „Wymuś zatrzymanie”, potem otwórz aplikację i Watcher | Komunikat „Poprzedni skan (demo) został przerwany…”; w Historii → Testy demo wpis „Przerwany (proces zakończony)” z liczbą postów z chwili przerwania. |
| 3a.2 | Ten sam test z kartą „Ostatnie aplikacje” → przesunięcie aplikacji | Jak 3a.1 albo skan kończy się normalnie, jeśli system nie zabił procesu — zapisz, co się stało. |
| 3a.3 | Automat w oknie (jak 3.2), w trakcie skanu „Wymuś zatrzymanie” | Przy następnym ticku: wpis „Przerwany”, w panelu „WorkManager i okna” okno „przerwane · próby 1/2”, potem ponowna próba (2/2) i okno „wykorzystane”. |
| 3a.4 | Diagnostyka | `SCAN_RECOVERED_INTERRUPTED`, potem `AUTO_SCAN_START … próba 2/2`. |

## 3b. Test WorkManagera bez komputera (Android 16)

| # | Krok | Oczekiwany wynik |
| --- | --- | --- |
| 3b.1 | Historia → „WorkManager i okna” → „Test za 1 min”, ekran włączony, ładowarka, Wi-Fi | Po ok. 1–2 min stan „wykonane”, w diagnostyce `PROBE_RAN` z opóźnieniem w sekundach. |
| 3b.2 | „Test za 15 min”, zablokuj telefon, ładowarka, Wi-Fi | Zapisz opóźnienie z `PROBE_RAN` (ekran włączony=false, doze=…). |
| 3b.3 | „Test za 15 min” bez ładowarki (harmonogram wymaga ładowania) | Stan „czeka” do podłączenia ładowarki; po podłączeniu uruchomienie. |
| 3b.4 | Bateria aplikacji „Zoptymalizowana” vs „Bez ograniczeń” | Powtórz 3b.2 w obu ustawieniach i porównaj opóźnienia. |
| 3b.5 | Automat włączony, panel | „Automat (co 15 min): czeka, najwcześniej …”; po zatrzymaniu przez system widoczny kod `stop`. |

Opcjonalnie, tylko z komputerem albo Termuxem z debugowaniem bezprzewodowym (nie jest wymagane):
`adb shell am set-standby-bucket pl.jakubokruszek.flipcollector.debug rare`, `adb shell dumpsys deviceidle force-idle`, `adb shell am compat enable OVERRIDE_QUOTA_ENFORCEMENT_TO_TOP_STARTED_JOBS pl.jakubokruszek.flipcollector.debug` — do porównania z zachowaniem bez wymuszeń.

## 3c. Grupy i synchronizacja

| # | Krok | Oczekiwany wynik |
| --- | --- | --- |
| 3c.1 | Grupy → „Synchronizuj grupy” | „Ostatnio: … — oczekuje na kontrakt backendu (brak połączenia)”; żadnego ruchu sieciowego. |
| 3c.2 | Dodaj grupę ręcznie, „Wyłącz”, „Włącz”, „Usuń” | Plakietka „lokalna”; licznik „x z y” zmienia się zgodnie z przełącznikiem. |

## 4. Powiadomienia

| # | Krok | Oczekiwany wynik |
| --- | --- | --- |
| 4.1 | Harmonogram → „Zezwól na powiadomienia” | Systemowe pytanie o zgodę. |
| 4.2 | Skan demo | Powiadomienie „DEMO · Skan ręczny: Zakończony · Oferty: 6”. |
| 4.3 | Odmowa zgody | Skan działa, brak powiadomienia, brak błędu. |

## 5. Diagnostyka do raportu

Historia → „Kopiuj diagnostykę” → wklej do raportu. Zawiera wersję aplikacji, model telefonu, Androida, stan Wi-Fi i baterii oraz dziennik zdarzeń. Nie zawiera tokenów ani treści postów.

## 6. WebView przy wygaszonym ekranie (dopiero po włączeniu LIVE)

Nie do wykonania w tej wersji (bramka zamknięta). Plan na później: skan jednej grupy z włączonym ekranem → ten sam skan po zablokowaniu telefonu (oczekiwana blokada `SCREEN_OFF`) → po decyzji o modelu z `webview-bezpieczenstwo.md` pomiar, czy renderer i JavaScript działają przy wygaszonym ekranie.

## Czego ten test NIE sprawdza

- Skanowania prawdziwych grup Facebooka (wyłączone w tej wersji).
- Pracy WebView przy wygaszonym ekranie.
- Integracji z backendem (oczekuje na kontrakt).
