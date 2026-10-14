# Flip Collector — praca w tle na Androidzie 16 (Galaxy S25 FE)

Stan na 14.10.2026. Dotyczy wersji 0.3.1 (tryb demo). Źródła na końcu.

## Co aplikacja robi teraz

| Element | Rozwiązanie w 0.3.0 | Dlaczego |
| --- | --- | --- |
| Automat nocny | `PeriodicWorkRequest` co 15 min (`AutoScanWorker`), ograniczenia: sieć bez limitu (Wi-Fi), ładowanie | Android sam nie wybudza zadania, dopóki warunki nie są spełnione; to najtańszy wariant dla baterii. |
| Jeden skan na okno | klucz okna zapisany przed startem skanu | Kolejne kontrole w tym samym oknie tylko czekają; restart procesu nie uruchamia skanu drugi raz. |
| Limit czasu | skan automatyczny 8 min, grupa 3 min; skan ręczny 20 min | Pojedynczy worker WorkManagera ma limit czasu wykonania; 8 min mieści się w nim z zapasem. |
| Zatrzymanie przez system | worker anuluje skan i zapisuje `stopReason` (np. `STOP_REASON_QUOTA`, `STOP_REASON_TIMEOUT`, utrata ładowania lub Wi-Fi) | Diagnostyka zamiast cichego zniknięcia skanu. |
| Usługa pierwszoplanowa (FGS) | **brak** | Android od wersji 12 nie pozwala uruchomić FGS z tła (np. o 02:00). Tryb demo jej nie potrzebuje. |
| Powiadomienia | opcjonalne podsumowanie po skanie; od Androida 13 wymaga zgody `POST_NOTIFICATIONS` | Bez zgody aplikacja działa dalej, tylko bez powiadomienia. |
| Skan ręczny | w procesie aplikacji, podczas gdy ekran Watchera jest otwarty | Skan demo trwa kilka sekund. |

## Zmiany w Androidzie 16 istotne dla Watchera

- **Kwoty czasu działania zadań** (wszystkie aplikacje na Androidzie 16, niezależnie od `targetSdk`): kwota zależy od koszyka App Standby. Liczą się do niej także zadania uruchomione, gdy aplikacja była widoczna i działające dalej po przejściu w tło, oraz zadania działające równolegle z FGS. Dotyczy WorkManagera, JobSchedulera i DownloadManagera. Zalecana diagnostyka: `WorkInfo.getStopReason()`, a dla JobSchedulera nowe `getPendingJobReasonsHistory`.
- **FGS typu `dataSync`** (od Androida 15, przy `targetSdk` 35+): najwyżej 6 h na dobę. Po wyczerpaniu system wywołuje `onTimeout()` i daje kilka sekund na `stopSelf()`, a kolejne uruchomienie kończy się `ForegroundServiceStartNotAllowedException`. Licznik zeruje się, gdy aplikacja wróci na pierwszy plan.
- **Do testów** kwoty można wyłączyć na urządzeniu: `adb shell am compat enable OVERRIDE_QUOTA_ENFORCEMENT_TO_TOP_STARTED_JOBS <pakiet>` i `OVERRIDE_QUOTA_ENFORCEMENT_TO_FGS_JOBS`. Tylko do diagnozy, nie do produkcji.

## Ryzyka przyszłego skanowania na żywo (WebView)

1. **Wygaszony ekran.** Nie zakładamy, że WebView działa poprawnie przy wygaszonym ekranie, w zadaniu w tle. Renderowanie, timery JavaScriptu i sieć mogą być wstrzymywane (Doze, ograniczenia renderera). Do potwierdzenia wyłącznie testem fizycznym na S25 FE.
2. **Brak FGS w nocy.** O 02:00 aplikacja jest w tle, więc nie uruchomi FGS. Skan musi zmieścić się w limicie zwykłego workera albo trzeba przyjąć inny model: uruchomienie przez użytkownika (FGS `dataSync`, 6 h na dobę) albo skan przy otwartej aplikacji.
3. **Kwoty Androida 16.** Częste lub długie zadania w nocy mogą dostać `STOP_REASON_QUOTA`. Diagnostyka zapisuje każdy taki przypadek.
4. **Samsung.** Ustawienie „Bateria → Bez ograniczeń” dla aplikacji wpływa na koszyk standby. Trzeba je sprawdzić w testach, a nie zakładać.

Obchodzenia zabezpieczeń Androida (wake locki na całą noc, sztuczne podtrzymywanie ekranu, nadużywanie FGS) aplikacja nie stosuje i nie będzie stosować.

## Źródła

- [Android 16 — zmiany dla wszystkich aplikacji (kwoty zadań)](https://developer.android.com/about/versions/16/behavior-changes-all)
- [Android 15 — zmiany dla aplikacji z targetSdk 35 (limit FGS dataSync)](https://developer.android.com/about/versions/15/behavior-changes-15)
- [WorkInfo — kody `STOP_REASON_*`](https://developer.android.com/reference/androidx/work/WorkInfo)
