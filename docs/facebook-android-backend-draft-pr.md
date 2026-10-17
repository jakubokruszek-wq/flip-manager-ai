# Draft PR integracyjny — treść do publikacji

Title: feat: integrate disabled Android Facebook API and offline WebView validation

Base: main. Head: feat/facebook-android-integration. Draft: true.

Telefon otrzymuje osobny consumer, podpisane API źródeł/kolejki/statusu,
fencing lease i finalizację z trwałym checkpointem. Klient Kotlin korzysta
z nowych ścieżek, zaszyfrowanego outboxa i lokalnych przełączników źródeł.
Adapter offline używa niezmienionego rdzenia rozszerzenia. Publiczne API
odrzuca domeny DEMO i OFFLINE_TEST. LIVE i integracja są wyłączone domyślnie.

Import Androida: dokładnie zweryfikowany b949349e53cb093b3ba29e6b9910f686ad565728
z PR #22. Oryginalny PR i obie gałęzie pozostają zachowane. APK integracyjny
ma osobny suffix .integration i nie zastępuje produkcji ani APK .debug Claude.

Lokalnie: 85 backend +242 regresje +58 offline/core =385 PASS.
Pełny tsc/ESLint/build, SQL, Kotlin/JVM/emulator/APK i systemowy E2E nie zostały
wykonane z powodu ograniczeń środowiska. Przygotowano manualne workflow
walidacji i testu z PostgreSQL16. Bez merge do main można je uruchomić przez
ręczne dodanie etykiety run-facebook-android-tests po przeglądzie Draft PR.

Nie gotowe do aktywacji: dokładne dodatnie liczniki fizycznych zapisów (obecnie
null zamiast zawyżania), pełny schemat/historyczne migracje, spięcie kontrolera
kontynuacji z automatem, wykonanie Kotlin i pełny E2E persystencji Findera.
Testowy adapter SQL nie zastępuje produkcyjnego persistListing.

Dokumentacja w docs: facebook-android-backend-contract.md,
facebook-android-integration-progress.md, facebook-android-backend-validation.md,
facebook-android-integration-handoff.md.

SQL pozostaje review-only draftem. Nie zmieniano produkcji, OLX, Cloudflare,
aktywnego filtra Flip ani płatności. Bez skanów, sesji FB, Vision, merge
i deploymentu. Nie zatwierdzać LIVE na podstawie testów z mockami.

Publikacja zablokowana: GitHub HTTP403 Resource not accessible by integration
podczas create branch. Brak nowego zdalnego PR; bez obchodzenia uprawnień.
Zmiany zachowano lokalnie w commitach i pakiecie odtworzeniowym.
