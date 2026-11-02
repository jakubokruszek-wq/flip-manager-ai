# 0.5.70: dostęp do godzin przy długim dzienniku

0.5.69 używał jednocześnie standardowej wiadomości AlertDialog i osobnego widoku przycisków. Długi dziennik zajmował dostępną wysokość i wypychał edycję godzin poza ekran. Panel ma teraz jeden przewijany widok: przyciski na początku, opis i dziennik poniżej. Dziennik nie może zabrać miejsca osobnemu panelowi akcji. Dane, logowanie i harmonogram pozostają bez zmian.

Test regresji otwiera rzeczywisty panel z 200 wierszami dziennika w oknie 320×480 dp, sprawdza pełną widoczność przycisku oraz przewijanie i otwiera edytor godzin. Dotychczasowy test edycji, zapisu i odtworzenia Activity pozostaje w zestawie.
