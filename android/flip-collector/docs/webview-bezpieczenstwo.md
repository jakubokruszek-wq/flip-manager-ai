# Planowany WebView kolektora — bezpieczeństwo, cykl życia, sesja, wygaszony ekran

Stan na 15.10.2026, wersja 0.4.0. WebView **nie jest uruchamiany**: bramka `LiveCollectionGate` jest zamknięta (`BuildConfig.LIVE_COLLECTION_ENABLED = false`, brak zgody na sesję). Kod: `watcher/android/CollectorBrowser.kt`, reguły: `collector/WebViewPolicy.kt` (testy `WebViewPolicyTest`).

## 1. Ustawienia i powierzchnia ataku

| Ustawienie | Wartość | Powód |
| --- | --- | --- |
| Nawigacja ramki głównej | tylko `https://www.facebook.com`, `m.facebook.com`, `facebook.com` | Link z posta nie wyprowadzi skanera poza Facebooka; `l.facebook.com` (przekierowania), `intent:`, `file:`, `javascript:`, `data:`, `http:`, inne porty i `user@host` są blokowane. |
| Zasoby | Facebook + `*.fbcdn.net`, `*.facebook.net`; obrazy i wideo blokowane | Skan tylko danych, jak w rozszerzeniu; mniej transferu i baterii. |
| `allowFileAccess`, `allowContentAccess` | false | Strona nie odczyta plików telefonu. |
| `addJavascriptInterface` | **nie używany** | Most JS→Kotlin przez obiekt jest klasycznym wektorem ataku; plan: `WebMessagePort`/`addWebMessageListener` z listą dozwolonych źródeł. |
| Nowe okna, geolokalizacja, autoodtwarzanie | wyłączone | Brak wyskakujących okien i uprawnień. |
| Mixed content | `NEVER_ALLOW` | Tylko HTTPS. |
| Safe Browsing | włączony | Ochrona przed stronami złośliwymi. |
| Ciasteczka stron trzecich | wyłączone | Sesja tylko pierwszej strony (Facebook). |

## 2. Sesja Facebooka

- Sesja = ciasteczka WebView w danych prywatnych aplikacji (`/data/data/<pakiet>/app_webview`). `android:allowBackup="false"`, więc nie trafia do kopii zapasowej.
- **Zapis tylko po osobnej zgodzie.** Zgoda jest częścią bramki; bez niej WebView w ogóle nie powstaje, więc nie zapisuje żadnych ciasteczek.
- „Usuń sesję Facebooka” (`WebViewCollectorBrowser.clearSession`) czyści ciasteczka i Web Storage. Odinstalowanie aplikacji usuwa wszystko.
- Aplikacja **nigdy** nie odczytuje, nie loguje ani nie wysyła ciasteczek ani hasła; logowanie odbywa się na stronie Facebooka w WebView.
- Ryzyko: telefon bez blokady ekranu = dostęp do sesji. Zalecenie: blokada ekranu; rozważyć wymóg blokady przed włączeniem LIVE.

## 3. Cykl życia

1. Tworzenie tylko na wątku głównym, tylko gdy bramka otwarta i ekran włączony (`BrowserBlocker`).
2. Jeden WebView na proces, kontekst aplikacji (bez wycieku Activity).
3. `close()`: `stopLoading` → `about:blank` → `destroy`. Wywoływane po skanie, przy „Zatrzymaj” i przy przekroczeniu limitu czasu.
4. `onRenderProcessGone`: renderer zabity przez system (OOM w tle) lub awaria → WebView porzucony i zniszczony, skan grupy kończy się błędem, aplikacja nie ulega awarii (bez obsługi system zabiłby cały proces).
5. Przerwanie procesu w trakcie: dziennik skanu (`ScanJournal`) → przy następnym starcie rekord „Przerwany”, okno oznaczone jako przerwane, jedna ponowna próba w oknie.

## 4. Wygaszony ekran — ryzyko przerwania

**Nie zakładamy, że WebView działa przy wygaszonym ekranie.**

- Przy wygaszonym ekranie Chromium w WebView może dławić timery JS, `requestAnimationFrame` i renderowanie stron, które nie są widoczne; WebView niepodpięty do okna bywa traktowany jako ukryty.
- Doze i App Standby wstrzymują sieć i odraczają zadania; WorkManager w tle ma limit czasu i kwoty (Android 16, patrz `android-16-praca-w-tle.md`).
- O 02:00 aplikacja jest w tle: nie może uruchomić usługi pierwszoplanowej ani pokazać Activity z tła.
- Dlatego `BrowserBlocker.SCREEN_OFF` blokuje start sesji WebView przy wygaszonym ekranie. Zmiana tej reguły wymaga pomiarów na S25 FE (plan: `test-samsung-s25fe.md`, sekcja 6).

Możliwe modele do decyzji po testach (bez obchodzenia zabezpieczeń Androida):

| Model | Plusy | Minusy |
| --- | --- | --- |
| A. Skan przy włączonym ekranie, uruchamiany przez użytkownika (FGS `dataSync`) | Pewne działanie WebView; zgodne z zasadami Androida | Nie w nocy bez udziału użytkownika; limit 6 h/dobę dla `dataSync` |
| B. Nocny worker z WebView przy wygaszonym ekranie | Bez udziału użytkownika | Niepotwierdzone; ryzyko wstrzymania renderera i kwot — tylko jeśli testy fizyczne to potwierdzą |
| C. Nocne przypomnienie (powiadomienie) → skan po odblokowaniu rano | Proste, zgodne z zasadami | Opóźnienie wyników do rana |

## 5. Lista kontrolna przed włączeniem LIVE

- [ ] Zgoda użytkownika na sesję Facebooka (ekran zgody, odwołanie zgody = `clearSession`).
- [ ] Kontrakt backendu (kolejka, lease, wyniki) i klient z testami.
- [ ] Wstrzykiwanie skryptów przez `WebMessagePort` z listą źródeł; bez `addJavascriptInterface`.
- [ ] Test fizyczny: WebView przy wygaszonym ekranie (sekcja 6 planu testów).
- [ ] Przegląd bezpieczeństwa tego dokumentu po implementacji.
