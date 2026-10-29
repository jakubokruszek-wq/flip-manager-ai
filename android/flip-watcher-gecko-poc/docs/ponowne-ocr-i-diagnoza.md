# Ponowne przetwarzanie — 0.5.61

OCR zapisanych zdjęć czyta wyłącznie pełniejsze, przypisane do postów wycinki z prywatnego archiwum. Nie rozpoznaje małych miniatur, nie otwiera Facebooka ani nowego wyszukiwania. Stosuje ten sam lokalny model i parser pól; do 20 obrazów i 2 minut. Zapisuje osobne sugestie po każdym poprawnie rozpoznanym obrazie. Puste odczyty nie usuwają wcześniejszych sugestii. Pauza zatrzymuje dalszy OCR; ukończone checkpointy pozostają. To jeszcze nie usługa OCR w tle.

Zachowane posty do ręcznego sprawdzenia można ponownie uzupełnić bez wyszukiwania od początku. Odczyt wymaga jawnego otwarcia zatwierdzonej grupy i nowej zgody; historyczny DTO nigdy nie zastępuje dowodu bieżącego dokumentu.

Sprawdź zdjęcie tego posta otwiera wyłącznie jeden wybrany, dokładny link (również rozpoznanej oferty). Pomija OCR pozostałych zdjęć z cache. Nadal obowiązują świeży port, dokładna tożsamość, widoczność/fokus i warunki bezpiecznego przechwycenia. Wynik diagnozy zawiera ID/permalink wybranego posta oraz liczniki IMG/SVG/CSS, potwierdzonych źródeł, powiązania elementów i geometrii. Bez HTML, źródłowych URI zdjęć i tekstu OCR. Ostatnia diagnoza jest w Narzędziach; Kasuj bazę usuwa ją razem z wynikiem.

Diagnoza nie rozluźnia reguł przypisywania obrazu do posta. Ustalenie przyczyny rzeczywistego Facebooka wymaga wyniku tej jednej próby na telefonie; syntetyczne testy nie są takim dowodem.

Domyślny raport OCR jest krótki. Pełne liczniki i dane parsera są dostępne po wybraniu Diagnostyka.
