# Nieruchomości i Inwestycje

Nieruchomości zawierają tylko ręcznie dodane mieszkania oraz oferty wybrane przyciskiem „Dodaj do CRM”. Skanowanie Watchera i Radaru nie tworzy inwestycji.

1. Dodaj mieszkanie, otwórz kartę i zapisz kontakt, termin oglądania, checklistę oraz notatki.
2. W „Zdjęcia i dokumenty” dodaj zdjęcia z oglądania. Nazwa pliku może wskazywać pomieszczenie. Dokumenty zapisują się od razu, pozostałe pola przyciskiem „Zapisz zmiany”.
3. Po zakupie wpisz faktyczną cenę i datę oraz wybierz „Kupiona — utwórz inwestycję”. To ten sam rekord; notatki i załączniki pozostają zachowane.
4. W Inwestycjach dodawaj akt, umowy, zdjęcia przed/w trakcie/po remoncie oraz wizualizacje. Obsługiwane: JPG, PNG, WebP i PDF, maks. 12 MB na plik. Dokumenty są prywatne; podpisane linki wygasają po 15 minutach, można je odświeżyć.
5. Ustal budżet w każdej kategorii. Puste pole oznacza nieznany plan, 0 oznacza brak wydatków w danej kategorii. Prognoza zysku pojawia się po uzupełnieniu całego budżetu i planowanej ceny sprzedaży. Uwzględnia większą z kwot w każdej kategorii: plan lub zapisane koszty.
6. Dodaj fakturę ze zdjęcia. OCR działa w przeglądarce, bez płatnego AI; przy pierwszym użyciu pobiera model językowy. Odczyt jest propozycją: sprawdź kwotę brutto, sprzedawcę i numer przed dodaniem kosztu. PDF można dołączyć i uzupełnić ręcznie. Przesłanie samego dokumentu nie zwiększa kosztów. Powtórzenia dokumentu lub numeru faktury tego samego sprzedawcy są blokowane.
7. Oznaczaj zapłatę, zwroty, zadania, wykonawców i terminy. Po sprzedaży uzupełnij cenę i datę. Wynik uwzględnia wszystkie wpisane koszty, również niezapłacone. Wpisz również podatki i koszty sprzedaży.

## Wdrożenie

Migracja `20261110221903_property_workspaces.sql` jest addytywna. Nie modyfikuje dawnych cen, wycen ani zapisanych ofert. Nowe tabele mają RLS, dokumenty trafiają do prywatnego bucketu. Zapis wersjonowany chroni przed nadpisaniem zmian z innego okna; etap nieruchomości i historia zapisu aktualizują się w tej samej transakcji. Stara ścieżka `/dashboard` przekierowuje do `/investments`.

Kod i WASM OCR są kopiowane do `public/ocr` podczas `npm ci` (postinstall), wyłącznie dane językowe pobierane są z tessdata.projectnaptha.com. Brak płatnych wywołań modelu AI. Zdjęcie faktury pozostaje w prywatnym magazynie użytkownika.

### Oglądanie i opłacalność przed zakupem

Nieruchomości mają cztery sekcje: podsumowanie, oglądanie, kosztorys/opłacalność oraz zdjęcia/dokumenty. Ocena każdego elementu ma stan niesprawdzony, OK, lekkie korekty lub wymiana/naprawa. Stare checkboxy są zachowane, ale nie są dowodem dobrego stanu technicznego. Nowy kosztorys zapisuje się w istniejącym JSON karty, bez przebudowy danych ani usuwania wcześniejszych kosztów.

OK liczy 0. Pozostałe stany wymagają stawki i ilości albo własnej kwoty; niesprawdzone można wycenić wyłącznie przez jawne założenie własnej kwoty. Wykończenie za m² nie obejmuje osobno wpisanych instalacji i okien. Puste pozycje blokują limit zakupu; 0 jest świadomym założeniem braku kosztu. Koszty stałe, procentowe koszty zakupu/sprzedaży, rezerwa i minimalny zysk wyznaczają maksymalną cenę zakupu. Obliczenia są w groszach; wyszukiwanie limitu uwzględnia zaokrąglenie kosztów procentowych. Podatek dochodowy nie jest automatycznie obliczany — jeśli ma pomniejszać wynik, użytkownik wpisuje plan w innych kosztach.

Po potwierdzeniu faktycznej ceny i daty zakupu ten sam rekord przechodzi do Inwestycji. Kompletny kosztorys uzupełnia wyłącznie brakujące budżety wykonawcze; wcześniejsze plany i zarejestrowane wydatki pozostają. Faktury, wykonawcy, remont i rozliczenie sprzedaży są dostępne w Inwestycjach. Przed zakupem nowe dokumenty należą do oglądania, dokumentów lub wizualizacji/rzutów; istniejące załączniki pozostają dostępne niezależnie od dawnej kategorii.

Usuwanie jest dostępne na karcie i listach przy każdym etapie. API sprawdza właściciela workspace. Po usunięciu rekordu i metadanych usuwa obiekty z prywatnego prefiksu właściciel/nieruchomość; awaria magazynu zwraca 503 i pozwala ponowić ten sam przycisk bez dostępu do cudzych plików. Zdjęcia są ładowane leniwie, partiami po 12; OCR i edytor załączników mają osobne, warunkowo ładowane moduły.
