# Automat telefonu 0.5.68

Kod bazuje na 0.5.67, pakiet i stały certyfikat pozostają te same. Instalacja jako
aktualizacja zachowuje profil Gecko, cookies, parowanie oraz zaszyfrowane archiwa.
Nie odinstalowywać działającej aplikacji.

W Narzędziach otwórz „Automat 3× dziennie / stan”. Najpierw sparuj Managera.
Włączenie automatu udziela osobnej trwałej zgody na skany aktywnych grup i wysyłkę
wybranych pól ofert oraz przypisanych miniatur zdjęć. Godziny: 07:00, 15:00, 23:00
według strefy telefonu. Android WorkManager sprawdza okno co najmniej co 15 minut;
Doze, oszczędzanie baterii, brak sieci, zatrzymanie aplikacji lub limity Androida
mogą opóźnić wykonanie. Nie obiecujemy dokładnych alarmów ani działania po Force stop.
Po ponownym uruchomieniu system przywraca pracę WorkManagera. Nie ma komputera,
zewnętrznego wykonawcy, nowego hostingu ani serwerowego harmonogramu.

Skan jest wykonywany w sesji Gecko z własną powierzchnią renderowania, gdy aplikacja
nie jest na pierwszym planie. Otwarcie aplikacji przerywa pracę przeglądarki automatu.
Nie ma automatycznego logowania, rozwiązywania CAPTCHA ani przechodzenia do obcej grupy.
Powiadomienie informuje o trwającej pracy. Pomyślnie zapisane źródło jest oznaczane
w danym oknie dopiero po utrwaleniu wyników; nieudane próby mogą być ponawiane.
Aktualna lista aktywnych grup jest pobierana z Managera przed każdym przebiegiem.
Obsługiwane pozostają dokładnie źródła znane wersji 0.5.67.

Dane automatu są w osobnej lokalnej bazie `watcher-outbox-v1.db`; treść ofert i JPEG
są szyfrowane AES-GCM kluczem Android Keystore. Dotychczasowe archiwa ręcznych wyników
pozostają niezmienione. Zaszyfrowane snapshoty i potwierdzenia zostają lokalnie także
po wysyłce. Dziennik przechowuje ostatnie 200 wpisów z czasem, kodem i licznikami,
bez cookies, tokenów, pełnych URL lub treści postów. Panel pokazuje ostatnie wpisy
oraz liczbę oczekujących, zablokowanych i potwierdzonych wysyłek.

Każdy post ma niezmienne body i klucz SHA-256 powiązany z urządzeniem, grupą, ID posta
oraz body, zapisane przed HTTP. Retry wysyła dokładnie te same bajty i klucz.
Potwierdzenie musi zawierać ten klucz, poprawny UUID oferty i status importu.
Dopiero potem kolejka oznacza zapis jako wysłany. Zerwane połączenie lub utrata
odpowiedzi po zapisie nie tworzy drugiej oferty: backend używa istniejącego importera,
unikalnego klucza urządzenia i kanonicznej tożsamości posta. Nowa wersja danych
aktualizuje tę samą ofertę. JPEG ma adres zależny od SHA-256 bajtów, więc ponawianie
nie tworzy kolejnych kopii tego samego pliku. Błędy 408/429/5xx i sieciowe mają
opóźnienie wykładnicze; inne 4xx pozostają zablokowane, z możliwością ręcznego ponowienia.
Kolejka innego sparowanego urządzenia nigdy nie jest wysyłana nowym tokenem.

Endpoint `/api/collector/facebook/mobile` musi zostać wdrożony w istniejącym Managerze.
Sprawdza token, aktywną grupę, dokładny permalink i związanie klucza z body. Przyjmuje
maks. 512 KiB i trzy JPEG 192×144, wyłącznie obrazy przypisane do konkretnego posta
przez istniejący mechanizm. To miniatury, nie oryginalne pliki galerii. Nie są wysyłane
pełne odpowiedzi Facebooka, dane formularzy, hasła, cookies ani OCR.
Wybrane pola liczbowe nie są zamieniane w rzekomą oryginalną treść posta. Nieznany
opis, autor i data publikacji zostają nieznane. Snapshot nie pogarsza istniejących
opisów, zdjęć ani decyzji filtrów. Nowe wpisy mają workflow `review`, bez zgadywania
intencji lub automatycznego kwalifikowania do Findera. Nie ma migracji schematu.

## Weryfikacja przed udostępnieniem APK

- JVM: trzy okna, granice czasu, zmiana DST, stabilny hash i ograniczony backoff.
- JS: istniejący parser/adaptacja i kontrakt HTTP, utrata odpowiedzi po commit,
  niepoprawne powiązanie zdjęć, odrzucenie przekroczenia rozmiaru.
- Importer Managera: zachowanie wcześniejszych pól, zdjęć i decyzji filtrów.
- Instrumentacja Androida: odtworzenie zaszyfrowanej kolejki, dedup po restartach,
  zachowany receipt, blokada/ponowienie i prawdziwy render Gecko bez Activity.
- Pełna dotychczasowa regresja emulatorowa, baza/profil i podpis APK.

CI przechowuje kandydat APK po kompilacji; artefakt „flip-watcher…” jest publikowany
wyłącznie po powodzeniu guard, build i instrumented. Testy Gecko używają lokalnego
HTML. Nie dowodzą działania na zalogowanym koncie Facebooka: przed uznaniem automatu
za gotowy do codziennej eksploatacji potrzebny jest test fizycznego telefonu z
wygaszonym ekranem, restartem i utratą sieci oraz kontrola odbioru ofert i zdjęć
w Managerze. Nie oznaczać tych prób PASS bez faktycznych wyników.
