# Pierwsze testy na Samsungu Galaxy S25 FE (Android 16)

Wersja: Flip Collector 0.3.1, build debug (`pl.jakubokruszek.flipcollector.debug`, „Flip Collector (test)”).
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
| 2.2 | Historia | Wpis „Ręczny · DEMO · Zakończony”, 12 postów, 6 ofert, „Wysłane do Flip Managera: 0”. |
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

## 4. Powiadomienia

| # | Krok | Oczekiwany wynik |
| --- | --- | --- |
| 4.1 | Harmonogram → „Zezwól na powiadomienia” | Systemowe pytanie o zgodę. |
| 4.2 | Skan demo | Powiadomienie „DEMO · Skan ręczny: Zakończony · Oferty: 6”. |
| 4.3 | Odmowa zgody | Skan działa, brak powiadomienia, brak błędu. |

## 5. Diagnostyka do raportu

Historia → „Kopiuj diagnostykę” → wklej do raportu. Zawiera wersję aplikacji, model telefonu, Androida, stan Wi-Fi i baterii oraz dziennik zdarzeń. Nie zawiera tokenów ani treści postów.

## Czego ten test NIE sprawdza

- Skanowania prawdziwych grup Facebooka (wyłączone w tej wersji).
- Pracy WebView przy wygaszonym ekranie.
- Integracji z backendem (oczekuje na kontrakt).
