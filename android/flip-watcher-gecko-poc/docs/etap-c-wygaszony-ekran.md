# Etap C: praca przy wygaszonym ekranie (projekt i test na lokalnym HTML)

Ten dokument **nie** uruchamia niczego na Facebooku. Opisuje, co trzeba potwierdzić na Samsungu, zanim w ogóle rozważymy nocny test LIVE (wymaga osobnej zgody).

Oznaczenia:
- **[F]** fakt z dokumentacji platformy;
- **[H]** hipoteza;
- **[T]** wymaga testu na telefonie.

## 1. Ograniczenia Androida

| Mechanizm | Co oznacza dla nas |
|---|---|
| WorkManager | [F] Jedno zadanie działa maksymalnie ~10 min, a jego start zależy od Doze, App Standby i limitów zadań (Android 16 zmienił sposób liczenia limitów). Nadaje się na strażnika i ponowienia, nie na precyzyjny start skanu o 3:00. |
| Usługa pierwszoplanowa (FGS) | [F] Od Androida 12 nie da się jej uruchomić z tła, poza wyjątkami. Jednym z nich jest **dokładny alarm** (`setExactAndAllowWhileIdle` / `setAlarmClock`). [F] Od Androida 14 dokładne alarmy wymagają zgody użytkownika „Alarmy i przypomnienia” (`SCHEDULE_EXACT_ALARM`). [F] Od Androida 15 typ `dataSync` ma łączny limit ~6 h na dobę; to nam wystarcza, bo skan trwa kilka–kilkanaście minut. |
| Doze | [F] Przy wygaszonym ekranie i bezruchu sieć oraz alarmy są wstrzymywane do okien serwisowych. Alarm `…AllowWhileIdle` może wybudzić telefon. Sieć w trakcie FGS jest dostępna [F], ale [T] na Samsungu. |
| Samsung | [F, dontkillmyapp] Samsung dodaje własne „Uśpione / Głęboko uśpione aplikacje” i agresywne zamykanie procesów. Aplikację trzeba ręcznie ustawić na „Bateria: bez ograniczeń”. To ustawienie użytkownika, nie obejście. |
| Wake lock | [F] `PARTIAL_WAKE_LOCK` utrzymuje CPU przy wygaszonym ekranie. Używamy go z twardym limitem 3 min w teście. |

## 2. GeckoView przy wygaszonym ekranie: główne niewiadome

- [F] Bez podłączonego widoku (GeckoView) sesja nie ma powierzchni do rysowania. `GeckoSession.setActive(false)` dławi sesję jak kartę w tle.
- [H] Przy `setActive(true)` w usłudze JavaScript i sieć działają, ale **bez powierzchni może nie działać** `requestAnimationFrame` oraz `IntersectionObserver`. Jeśli tak jest, to zwykle **przewijanie nie doładowuje kolejnych postów**: kanał Facebooka doładowuje się właśnie tak.
- [H] Gecko może wstrzymywać proces treści przy zablokowanym ekranie albo pod presją pamięci (`onKill`). Wtedy aplikacja pokazuje STOP.
- Foreground Service **nie gwarantuje** renderowania. Gwarantuje tylko, że proces nie zostanie zamrożony przez system.

Dlatego test używa strony `lazy-feed.html`:
- na starcie pokazuje 5 postów;
- kolejne 5 dokłada dopiero, gdy element-strażnik stanie się widoczny (IntersectionObserver + requestAnimationFrame), maksymalnie 30;
- skan robi 4 przewinięcia.

Jak czytać wynik:
- **5 postów** oznacza, że doładowanie przy wygaszonym ekranie nie działa (wariant headless odpada; trzeba szukać innej drogi).
- **≥ 10 postów** oznacza, że doładowanie działa.

### Pierwszy pomiar: emulator Android 16 w CI (nie Samsung)

Ta sama strona, 4 przewinięcia:

| Tryb sesji | Postów | Wniosek |
|---|---|---|
| Widoczny GeckoView (kontrola) | 15 | Strona testowa i logika przewijania działają |
| **Bez powierzchni** (`SurfaceMode.NONE`) | **5** | Bez powierzchni lista się nie doładowuje; sam FGS nie wystarczy |
| **Powierzchnia poza ekranem** (`SurfaceMode.OFFSCREEN`, oficjalne `GeckoDisplay` + niewidoczny bufor `ImageReader`) | **10** | Doładowanie działa, choć wolniej niż na ekranie |

Wynik z emulatora wskazuje kierunek, ale nie jest dowodem dla Samsunga z wygaszonym i zablokowanym ekranem. Dlatego test na telefonie (sekcja 3) wykonuje **oba tryby** po kolei i zapisuje każdy jako osobny rekord (`surface=NONE` / `surface=OFFSCREEN`).

## 3. Test na telefonie (tylko lokalny HTML)

1. Ustawienia → Aplikacje → Flip Watcher — Gecko POC:
   - „Bateria: bez ograniczeń”;
   - „Alarmy i przypomnienia: zezwól”;
   - Powiadomienia: zezwól.
2. W aplikacji stuknij **„Test teraz”** (próba porównawcza, ekran włączony). Wynik przyjdzie w powiadomieniu i będzie w „Wyniki”.
3. Stuknij **„Test ekranu za 10 min”**. Podłącz ładowarkę, zablokuj telefon przyciskiem, odłóż go i **nie odblokowuj** przez 12 min.
4. Odblokuj telefon i stuknij „Wyniki”. Rekord `SCREEN_OFF_TEST` zawiera:
   - status i liczbę postów;
   - `start.screenOn=false`, `start.locked=true`;
   - `doze`, `charging`, `batteryTempC`;
   - `ignoringBatteryOptimizations`.
5. Powtórz 3 razy, w tym raz bez ładowarki i raz po 30+ min bezruchu, żeby sprawdzić Doze. Możliwe wyniki:
   - `FGS_START_REFUSED` oznacza, że Android odmówił startu (zwykle brak dokładnego alarmu);
   - `NOT_READY`: rozszerzenie nie połączyło się przy wygaszonym ekranie;
   - `OK` z 5 postami: brak doładowania;
   - `OK` z ≥ 10 postami: działa.

**GO C**: przy `start.screenOn=false` i `start.locked=true` status `OK` z ≥ 10 postami (w praktyce dla `surface=OFFSCREEN`), w 3 z 3 prób. Dopiero wtedy można rozmawiać o nocnym teście LIVE (osobna zgoda).

## 4. Jeżeli GO C się nie powiedzie

Kolejne opcje, każda wymaga osobnej oceny i testu:
- (a) Jeśli `OFFSCREEN` działa na ekranie, a nie działa po wygaszeniu, sprawdzić, czy Gecko wstrzymuje kompozytor przy blokadzie ekranu [T].
- (b) Skan przy włączonym, przyciemnionym ekranie na ładowarce, np. w trybie stacji dokującej. Prosty, ale zużywa ekran.
- (c) Ograniczenie się do skanu bez przewijania, częściej i z mniejszą liczbą postów.

Żadna z tych opcji nie obejmuje obchodzenia CAPTCHA, checkpointów ani ograniczeń Androida.

## 5. Harmonogram nocny, Wi-Fi, temperatura (projekt, do wdrożenia dopiero po GO A/B/C)

- Okna nocne, np. 01:00–05:00. Jeden dokładny alarm na okno, który startuje FGS (≤ 15 min) i wykonuje skan kolejnych grup. Między grupami pauza 30–90 s, po jednej grupie naraz.
- Warunki startu (inaczej pominięcie okna i wpis do dziennika):
  - ładowanie;
  - Wi-Fi bez limitu (`NetworkCapabilities.NET_CAPABILITY_NOT_METERED`);
  - temperatura baterii < 40°C;
  - poziom ≥ 30%.
- Przerwanie natychmiast, gdy wystąpi którekolwiek: checkpoint, CAPTCHA, wylogowanie, utrata dostępu, `onKill`/`onCrash`, temperatura ≥ 42°C. Automat zostaje wyłączony do ręcznej decyzji operatora.
- WorkManager jako strażnik: sprawdza, czy okno się odbyło, i ponawia najwyżej raz.
- Ponownie wykorzystać z Watchera:
  - `ScanCoordinator`, `ScanRecovery`, `AutoScanPlanner`;
  - outbox i lease.

  Źródłem stron zostaje GeckoView zamiast WebView.
