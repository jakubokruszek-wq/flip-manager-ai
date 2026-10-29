# Zachowany wynik i Kasuj bazę — 0.5.60

Nakładka zachowuje ostatni poprawny wynik, maksymalnie 20 postów. Nowe poprawne wyszukiwanie zastępuje poprzedni wynik. Pusty lub błędny przebieg nie kasuje ostatniego zapisu. Uzupełnianie zapisuje checkpoint po każdym potwierdzonym odczycie posta; błąd późniejszej strony nie usuwa wcześniejszego checkpointu.

Zapis obejmuje wybrane pola, dokładne linki zatwierdzonej grupy, do 3 miniatur na post, do 20 ograniczonych wycinków OCR i osobne sugestie OCR. Nie obejmuje całego HTML, odpowiedzi sieciowych, cookies, tokenów ani adresów źródłowych zdjęć. AES-GCM z kluczem Android Keystore, prywatny katalog no-backup, atomowa wymiana pliku. Zapis wymaga miejsca na dysku; błąd zachowuje poprzedni poprawny plik i wyświetla ostrzeżenie.

Zadania zapisu są szeregowane poza głównym wątkiem i nie należą do Activity. Mogą dokończyć zapis po pauzie lub rekreacji ekranu; śmierć całego procesu pozostawia ostatni zakończony checkpoint. To nie jest gwarancja pracy procesu w tle. Przeglądanie Facebooka i rozpoznawanie OCR nadal zatrzymują się po pauzie. Nie ma automatycznego ponawiania z utrwaloną zgodą.

Po restarcie aplikacja pokazuje historyczny wynik z datą. Nie przywraca sesji ani dowodu bieżącego dokumentu i nie uruchamia automatycznie OCR/otwierania postów. Dokładny zapisany link można otworzyć własnym kliknięciem w Facebooku lub przeglądarce. Kopiowany raport techniczny nadal zawiera wyłącznie liczniki.

Przycisk **Kasuj bazę** jest w Ofertach i Narzędziach. Po potwierdzeniu usuwa zapis, zdjęcia i OCR oraz ich kopie ekranowe. Kolejka wykonuje kasowanie po wcześniej zleconych zapisach, więc stary zapis nie odtworzy usuniętej bazy. Historia wysłanych danych, outbox, raporty liczbowe, limity i logowanie Facebooka pozostają bez zmian. Ponowne wyszukiwanie może utworzyć nowy wynik.

Weryfikacja obejmuje odtworzenie DTO/OCR/zdjęć, brak jawnych pól w pliku, walidację i limity, uszkodzenie szyfrogramu, przerwany zapis atomowy, kolejność zapisu/kasowania, pauzę i rekreację Activity, brak odtworzonej sesji lub automatycznego OCR, zachowanie wyniku po nieudanym wyszukiwaniu oraz anulowanie/potwierdzenie kasowania. Testy natywne używają danych syntetycznych; nie potwierdzają zachowania rzeczywistego Facebooka na Samsungu.
