# Powiązanie zdjęć — 0.5.62

Raport z telefonu dla jednego posta: 5 potwierdzonych źródeł, 68 IMG w dokumencie, wszystkie odrzucone przy powiązaniu, bez dojścia do geometrii lub OCR. Kod porównywał pełny URI, a alternatywny dowód wymagał article.

Nowe dopasowanie nadal zaczyna się od źródeł wydobytych z potwierdzonej własnej Story. Byte-exact URI pozostaje poprawnym dowodem. Dla statycznych plików scontent*.fbcdn.net/v/tNUM-NUM/NUM_NUM_NAME.(jpg/jpeg/png/webp/avif) identyfikator zasobu to dokładna ścieżka, z dopuszczeniem wariantów podpisu/rendycji i węzła CDN. Normalizacja wymaga bezpiecznego HTTPS, braku userinfo/portu/fragmentu, kontrolowanej domeny i wyłącznie znanych kluczy parametrów (_nc_*, oh, oe, stp, efg, ccb, edm). Inny plik, domena podszywająca się, dynamiczny endpoint lub nieznany parametr nie uzyskują dopasowania przez normalizację. Nie wyprowadza się ID posta z ID zdjęcia ani z nazwy pliku.

Poza article wymagane są jednocześnie: potwierdzony własny zasób, jawny link do dokładnego posta lub link photo z jednym set=pcb.POST_ID i numerycznym media-only fbid, właściwy main/dialog, brak komentarza/cytatu i poprawna ścieżka przodków. Sam bieżący adres strony, sam URI zdjęcia lub samo fbid nie wystarczają. Obcy article pozostaje wykluczony nawet wtedy, gdy pokazuje ten sam zasób. Kilka niespójnych kontenerów jest niejednoznaczne.

Podpis adresu można pominąć przy ustalaniu tożsamości zasobu, ale pełny bieżący URI musi pozostać identyczny od wyboru obrazu do commit. Zmiana po pikselach nadal skutkuje drop. Pozostały warunki załadowania, geometrii, zasłonięcia, dokładnego kontekstu, nonce i portu. Bez pobierania obrazów, eksportu URI i zapisywania całego widoku.

Diagnoza rozdziela dokładne i zasobowe dopasowanie URI, brak dopasowania, brak article, jawny link, obcą tożsamość oraz komentarz/cytat. Dane z 0.5.61 pozostają czytelne z nowymi licznikami równymi zero jako niezmierzone.

Testy JS pokrywają zgodne i sprzeczne URI, kontenery, źródło podmienione po pikselach i niedozwolone linki. Nowe testy Androida używają lokalnie wyrenderowanego PNG z syntetycznym getterem currentSrc przedstawiającym wariant CDN oraz rzeczywistego wycinania i MLKit. To nie test sieci CDN ani konta Facebook. Właściwe działanie na poście z telefonu pozostaje do potwierdzenia po aktualizacji.
