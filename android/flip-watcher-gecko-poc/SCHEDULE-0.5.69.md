# Flip Watcher 0.5.69

W panelu automatu wybierz „Godziny skanów”, ustaw trzy różne pory (godzina i minuta) i zapisz. Ustawienia są lokalne, według strefy czasowej telefonu. Domyślnie: 07:00, 15:00, 23:00. Zmiana harmonogramu obowiązuje od następnej pory; nie uruchamia starego okna. „Skan teraz w tle” zleca dodatkowy skan po opuszczeniu aplikacji.

Włącz automat i przejdź na ekran główny telefonu. WorkManager utrzymuje harmonogram po zamknięciu ekranu i restarcie telefonu; podczas skanu działa powiadomienie. Android może opóźnić zadanie przy braku sieci, Doze lub ograniczeniu baterii. W ustawieniach aplikacji Androida można zezwolić na pracę w tle. Po wymuszonym zatrzymaniu aplikacji otwórz ją ponownie. Skan ręczny nadal wymaga widocznej aplikacji. Facebook może zażądać ponownego logowania lub CAPTCHA.

Skan obejmuje wszystkie aktywne grupy zwrócone przez Managera, należące do obsługiwanej listy jedenastu grup. Błąd pojedynczej grupy nie blokuje kolejnych; po przerwaniu limitu czasu kolejna próba zaczyna za ostatnio podjętym źródłem. Automat wysyła oferty i przypisane miniatury przez istniejącą szyfrowaną kolejkę. Potwierdzone wysyłki i zakończone okna zachowują ochronę przed duplikatami. Archiwum skanów ręcznych jest oddzielne.

Instaluj jako aktualizację, bez odinstalowywania: baza, logowanie i parowanie pozostają na telefonie. Ten sam certyfikat podpisu co 0.5.68. Nie wymaga komputera do pracy ani nowego hostingu.

Walidacja: testy JVM harmonogramu, zmiany czasu i ograniczenia przekierowań; test rzeczywistego Android TimePicker z zapisem i odtworzeniem Activity; renderowanie Gecko bez Activity z lokalnym przekierowaniem i przypisanymi zdjęciami; istniejące testy kolejki i pełny zestaw CI. Emulatory używają lokalnych danych testowych. Nie stanowi to potwierdzenia działania na prywatnym koncie Facebook użytkownika.
