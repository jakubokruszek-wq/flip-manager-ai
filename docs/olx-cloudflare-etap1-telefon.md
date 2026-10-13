# Etap 1 OLX Cloudflare z telefonu (Android) — GitHub Actions

Workflow `.github/workflows/olx-cloudflare-stage1-deploy.yml` wdraża **wyłącznie** zablokowany Worker
testowy `flip-manager-olx-cloud-stage1` z `wrangler.stage1.toml` (PR #5, commit `3990a1a`).

Nie zmienia:
- istniejącego Workera `flip-manager-olx-cloud`;
- Supabase ani Vercel;
- sekretu `OLX_WORKER_SECRET` (nie jest ustawiany).

Wdrożony Worker nie może pobierać zadań (`OLX_CLOUD_STAGE1_LOCK=1`, `OLX_CLOUD_ENABLED=0`, `manual`).

Workflow uruchamia się **tylko ręcznie** (`workflow_dispatch`), nigdy po push.

Kolejność działań:
- **A.** token Cloudflare
- **B.** Account ID
- **C.** token administracyjny
- **D.** sekrety w GitHubie
- **E.** scalenie PR z workflow
- **F.** uruchomienie
- **G.** sprawdzenie
- **H.** sprzątanie

Wszystko wykonasz w Chrome na Androidzie. Jeśli jakiegoś menu nie widać, włącz w Chrome
**⋮ → Wersja na komputer**.

## A. Ograniczony token API Cloudflare

1. Otwórz `https://dash.cloudflare.com/profile/api-tokens` i zaloguj się.
2. **Create Token** → przy szablonie **Edit Cloudflare Workers** dotknij **Use template**.
3. **Token name**: `flip-manager-olx-stage1-github`.
4. **Permissions**: usuń ikoną kosza wiersze, które nie są potrzebne:
   - `Account · Workers KV Storage · Edit`
   - `Account · Workers R2 Storage · Edit`
   - `Zone · Workers Routes · Edit`

   Zostaw:
   - `Account · Workers Scripts · Edit`
   - `Account · Account Settings · Read`
   - `Account · Workers Tail · Read`
   - `User · User Details · Read`
   - `User · Memberships · Read`
5. **Account Resources**: `Include` → **tylko Twoje konto** (nie „All accounts”).
6. **Zone Resources**: jeśli sekcja nadal jest widoczna, wybierz jedną strefę albo usuń ostatni wiersz
   strefy. Worker testowy nie używa żadnych domen ani tras.
7. **Client IP Address Filtering**: zostaw puste (adresy runnerów GitHub się zmieniają).
8. **TTL**: ustaw datę końca za 7 dni, bo token jest potrzebny tylko na etap 1.
9. **Continue to summary** → **Create Token**. **Skopiuj token od razu**: Cloudflare pokaże go tylko raz.
   Opcjonalnie sprawdź go poleceniem `curl` pokazanym pod tokenem (na telefonie możesz pominąć).

Jeśli wdrożenie zakończy się błędem `Authentication error [code: 10000]` lub brakiem uprawnienia,
dodaj w tokenie (**Edit**) wskazane w logu uprawnienie, np. `Account · Browser Rendering · Edit`,
i uruchom workflow ponownie.

## B. Account ID

Panel Cloudflare → **Workers & Pages**. Account ID widać w prawej kolumnie („Account details”) albo
w adresie strony: `dash.cloudflare.com/<32 znaki>/…`. Skopiuj te 32 znaki (cyfry i litery a–f).

## C. Token administracyjny Workera

Losowy ciąg **co najmniej 32 znaków**, tylko litery i cyfry (bez spacji). Najprościej wygeneruj go
w menedżerze haseł, np. Menedżer haseł Google albo Bitwarden: „Generuj hasło”, długość 40, bez symboli.

Zapisz go w menedżerze haseł jako `OLX stage1 admin token`. Będzie potrzebny do `/status` i `/selftest`.

## D. Sekrety w GitHubie

Aplikacja GitHub na Androida nie edytuje sekretów, więc użyj przeglądarki:

1. Otwórz `https://github.com/jakubokruszek-wq/flip-manager-ai/settings/secrets/actions`.
2. **New repository secret** i dodaj trzy sekrety (nazwy dokładnie tak, wielkimi literami):

   | Name | Secret |
   |---|---|
   | `CLOUDFLARE_API_TOKEN_STAGE1` | token z kroku A |
   | `CLOUDFLARE_ACCOUNT_ID` | Account ID z kroku B |
   | `OLX_CLOUD_ADMIN_TOKEN_STAGE1` | token z kroku C |

3. Każdy zatwierdź **Add secret**. Wartości nie będą już nigdzie widoczne, także w logach workflow.

Środowisko GitHub `olx-cloudflare-stage1` utworzy się samo przy pierwszym uruchomieniu. Opcjonalnie
w **Settings → Environments → olx-cloudflare-stage1** możesz włączyć **Required reviewers** (siebie):
każde uruchomienie będzie wtedy wymagało dodatkowego zatwierdzenia.

## E. Scalenie PR z workflow (wymagane przez GitHub)

GitHub pozwala ręcznie uruchomić workflow tylko wtedy, gdy plik workflow jest na gałęzi domyślnej (`main`).

1. Aplikacja GitHub → repozytorium → **Pull requests** → PR „OLX Cloudflare: ręczny workflow
   wdrożenia Workera testowego (etap 1)”.
2. Przejrzyj **Files changed**: dwa pliki, workflow i ta instrukcja.
3. **Merge pull request** → **Confirm merge**.

Scalenie dodaje do `main` tylko te dwa pliki. **Nie scala PR #5** i nie uruchamia workflow.
Vercel zbuduje `main` ponownie, ale kod aplikacji się nie zmienia.

## F. Uruchomienie (jedno dotknięcie, dwa przebiegi zalecane)

Aplikacja GitHub → repozytorium → **Actions** → **OLX Cloudflare — etap 1 (ręczne wdrożenie Workera
testowego)** → **Run workflow**:

1. **Przebieg próbny:** zaznacz **„Tylko kontrola i dry-run, bez wdrożenia”** → **Run workflow**. Sprawdza
   konfigurację, sekrety i dry-run; niczego nie wdraża.
2. **Wdrożenie:** **Run workflow** z **odznaczonym** polem → **Run workflow**.

Kolejne kroki workflow:
1. pobranie commita `3990a1a` z PR #5;
2. kontrola `name = flip-manager-olx-cloud-stage1`, `OLX_CLOUD_STAGE1_LOCK = 1`, `OLX_CLOUD_ENABLED = 0`,
   `OLX_CLOUD_CLAIM_MODE = manual` (oraz brak tras, środowisk i sekretów w pliku);
3. kontrola sekretów (bez wypisywania wartości);
4. `npm ci`;
5. dry-run;
6. `wrangler deploy --config wrangler.stage1.toml`;
7. ustawienie `OLX_CLOUD_ADMIN_TOKEN`;
8. sprawdzenie `/health` i `/status`.

Każdy niespełniony warunek zatrzymuje workflow przed wdrożeniem.

## G. Sprawdzenie wyniku

Otwórz przebieg w **Actions** → **Summary**. Oczekiwane:
- „OLX Cloudflare — etap 1 wdrożony”;
- adres `https://flip-manager-olx-cloud-stage1.<subdomena>.workers.dev`;
- w JSON: `"code": "OLX_CLOUD_STAGE1_LOCKED"`, `configCheck.stage1Lock: true`,
  `configCheck.killSwitch: "disabled"`, `configCheck.workerSecret: "missing"`, `nextAlarm: null`,
  `running: false`.

Dodatkowo w Chrome:
- `https://flip-manager-olx-cloud-stage1.<subdomena>.workers.dev/health` → `{"ok":true,…}`;
- ten sam adres z `/status` → strona 404 (bez tokenu tak ma być);
- panel Cloudflare → **Workers & Pages**: jest nowy `flip-manager-olx-cloud-stage1`, a
  **`flip-manager-olx-cloud` ma niezmienioną datę ostatniego wdrożenia**.

Prześlij zrzut **Summary**.

## H. Po etapie 1

- Token Cloudflare wygaśnie sam (TTL). Możesz go też usunąć wcześniej (**API Tokens → ⋯ → Delete**),
  a sekret `CLOUDFLARE_API_TOKEN_STAGE1` w GitHubie skasować.
- Worker testowy niczego nie pobiera, więc może zostać. Usunięcie: panel → **Workers & Pages** →
  `flip-manager-olx-cloud-stage1` → **Settings** → **Delete**.
- Etap 1b (`OLX_WORKER_SECRET` + `/selftest`) i etap 2 wymagają osobnej zgody i nie są częścią tego
  workflow.
