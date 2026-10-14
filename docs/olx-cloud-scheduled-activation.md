# Worker „scheduled”: dlaczego włączenie nie stawało się aktywne (raport przyczyny)

Przebiegi: `38606455224` i `38607086215` (akcja `enable`), `38612095982` (`enable`, inny błąd), a dla kontekstu `38604780597` (`deploy-disabled`) i `38605669102` (`check`).

## 1. Objaw

| Czas (UTC) | Przebieg | Zdarzenie | Wersja |
|---|---|---|---|
| 17:14:23 | #2 `deploy-disabled` | `wrangler deploy` → `Current Version ID` | `661b1d34…` |
| 17:14:25–27 | #2 | 2 × `wrangler secret put` (każdy tworzy i **wdraża** nową wersję) | ostatnia: **`1d7f95d1…`** |
| 17:14:29 | #2 | `/status`: Worker = DO = `1d7f95d1`, OFF; wynik zaliczony, bo oczekiwano wersji `any` | `1d7f95d1` |
| 17:26:03 | #4 `enable` | `wrangler deploy --var OLX_CLOUD_ENABLED:1` → `Current Version ID` | `d8fa3951…` |
| 17:26:04–17:28:09 | #4 | 24 × `/status`: Worker = DO = **`1d7f95d1`**, `OLX_CLOUD_DISABLED` | stara |
| 17:28:16 | #4 | automatyczny rollback: `wrangler deploy` | `ed472480…` |
| ~17:30:40 | #5 `enable` | wdrożenie | `b3eced97…` |
| do 17:32:49 | #5 | `/status`: nadal **`1d7f95d1`** | stara |
| 17:32:56 | #5 | rollback | `a8e5aeb6…` |
| 18:04:56 | #6 `enable` | odrzucone na wejściu: `confirm` = `" WLACZ-AUTOMAT-OLX"` (spacja na początku) | — |

Wersja `1d7f95d1` zaczęła obsługiwać ruch w ciągu 2 s od `secret put`. Każda z czterech wersji z `wrangler deploy` po zgłoszonym sukcesie **nie pojawiła się na workers.dev** w trakcie oczekiwania (~125 s).

`/status` czyta `version.worker` w Workerze bez stanu, z `env.CF_VERSION_METADATA`, a `version.runner` w Durable Object. Ruch na workers.dev obsługiwała więc stara wersja w całości: Worker i DO. To nie była sama niezgodność DO.

## 2. Przyczyna

**Wrangler 4.143.1 domyślnie wdraża z odroczoną aktualizacją kodu Durable Objects.**

- `src/versions/deployment-args.ts`: `DEFAULT_DURABLE_OBJECTS_CODE_UPDATE_STRATEGY = { mode: "deferred", max_delay: 300 }`.
- `wrangler deploy` przekazuje tę strategię do API w obu ścieżkach:
  - nowej: `POST /workers/scripts/:name/deployments` z `code_update_strategy`;
  - klasycznej: `worker.code_update_strategy` w metadanych uploadu.
- Nadpisuje ją tylko `[durable_objects.code_update_strategy]` w konfiguracji albo flaga `--durable-objects-code-update-mode`.
- `wrangler secret put` używa osobnego endpointu (`PUT …/secrets`) **bez** tej strategii. Dlatego wersja z sekretu była aktywna od razu.

Skutek w tym Workerze, który ma Durable Object:
- wdrożenie jest zarejestrowane i ma nowe `Current Version ID`;
- przez okno odroczenia (do 300 s) ruch obsługuje poprzednia wersja;
- workflow czekał 24 × 5 s ≈ 2 min, krócej niż odroczenie;
- rollback po nieudanym włączeniu tworzył od razu kolejne odroczone wdrożenie, więc żadna nowa wersja nie zdążyła się aktywować.

Ten sam mechanizm opóźniał też akcję `disable`, czyli awaryjny STOP: do 5 min.

**Stopień pewności.** Mechanizm (domyślne `deferred 300 s` w `deploy`, brak go w `secret put`) wynika bezpośrednio z kodu wrangler 4.143.1. Zachowanie w logach pasuje do niego w każdym punkcie. Publiczna dokumentacja Cloudflare nie opisuje jeszcze trybu `deferred`.

**Sprawdzenie bez wdrażania.** Akcja `check` (tylko odczyt) powinna teraz pokazać wersję `a8e5aeb6…` (ostatni rollback, OFF), a nie `1d7f95d1`. Od tamtego wdrożenia minęło już ponad 300 s.

### Czego przyczyną to NIE było

| Hipoteza | Wynik |
|---|---|
| `--var OLX_CLOUD_ENABLED:1` nie nadpisuje konfiguracji | Nadpisuje. Wrangler (`props.cliVars`) zastępuje binding z `[vars]` wartością `plain_text "1"` z flagą `hidden`, dlatego log pokazuje `"(hidden)"`. Teraz sprawdza to `wrangler versions view <id> --json`. |
| Sama niezgodność Durable Object | Nie: Worker bez stanu też raportował `1d7f95d1`. |
| `wrangler secret put` blokuje późniejsze wdrożenia | Nie blokuje. Tworzy i wdraża własną wersję natychmiast. Problem w tym, że workflow oczekiwał wtedy wersji `any`, więc nie wiedział, którą wersję potwierdza. |
| Inne konto lub Worker (token Stage2 jako zastępstwo) | Nie: ta sama nazwa, konto i adres `jakub-okruszek.workers.dev`; wersja z `secret put` tego samego przebiegu była obsługiwana. |

## 3. Poprawka

| Zmiana | Plik |
|---|---|
| `[durable_objects.code_update_strategy] mode = "immediate"`: każde `wrangler deploy` tego Workera aktywuje się od razu, także STOP. Kontrola konfiguracji w workflow tego wymaga. | `wrangler.scheduled.toml`, workflow |
| Wdrożenie uznane za poprawne dopiero po trzech niezależnych dowodach dla **jednej konkretnej wersji**, nigdy `any`: (1) `wrangler deployments status --json` – 100 % ruchu na tę wersję; (2) `wrangler versions view --json` – `OLX_CLOUD_ENABLED` ma oczekiwaną wartość; (3) `/status` – Worker **i** DO działają w tej wersji w oczekiwanym stanie | workflow, `scripts/scheduled-status.sh` |
| Po `wrangler secret put` oczekiwaną wersją jest ta, którą Cloudflare podaje jako aktywną (`active-version`), a nie `any` | workflow |
| Warunek wstępny `enable`: wyłączony Worker musi działać w wersji aktywnej według API | workflow |
| Rollback potwierdzany tak samo (deployment + `/status` wyłączony dla jego wersji); niepowodzenie = jawny błąd z instrukcją STOP | workflow |
| Oczekiwanie 72 × 5 s = 6 min (dłużej niż 300 s ewentualnego odroczenia); limit joba 30 min | workflow |
| `confirm` ignoruje spacje na początku i końcu; sama fraza musi być dokładna | workflow |

### Rozdzielona diagnostyka (`scripts/scheduled-status.sh`)

| Kod | Znaczenie |
|---|---|
| `DEPLOYMENT_NOT_APPLIED` | Aktywny deployment w Cloudflare nie kieruje 100 % ruchu na wdrożoną wersję (np. inna wersja lub podział ruchu). |
| `DEPLOYMENT_STATUS_UNREADABLE` / `DEPLOYMENT_SPLIT` | Brak czytelnej odpowiedzi API albo kilka wersji w aktywnym deploymencie. |
| `VAR_NOT_APPLIED` | Wdrożona wersja nie ma oczekiwanego `OLX_CLOUD_ENABLED`. |
| `VERSION_NOT_ACTIVE` | Deployment poprawny, ale workers.dev nadal obsługuje inną wersję (przypadek z tych przebiegów). |
| `DURABLE_OBJECT_VERSION_MISMATCH` | Worker w nowej wersji, Durable Object w innej. |
| `STATE_MISMATCH` | Obie wersje zgodne, ale stan lub limity inne niż oczekiwane. |
| `STATUS_UNREACHABLE` | Brak poprawnej odpowiedzi `/status`. |

### Bez zmian
- Limity: 2/dobę, 1 na wywołanie, 1 trzymane, budżet 120 s z 600 s.
- Tryb `scheduled`, HMAC (`/selftest` 409), sekrety i ich kolejność, `OLX_CLOUD_ENABLED = "0"` w pliku.
- Automatyczny rollback po niepotwierdzonym włączeniu.
- Stage2 i pozostałe Workery: ich konfiguracje i workflow są nietknięte. Stage2 może mieć ten sam problem z odroczeniem; to osobna decyzja.

## 4. Testy

| Test | Zakres |
|---|---|
| `test/scheduled-activation.regression.test.ts` (8) | Rzeczywiste wartości z przebiegów: `d8fa3951` wdrożone a `1d7f95d1` obsługiwane → `VERSION_NOT_ACTIVE`; DO w starej wersji → `DURABLE_OBJECT_VERSION_MISMATCH`; zgodne wersje, ale OFF → `STATE_MISMATCH`; brak odpowiedzi → `STATUS_UNREACHABLE`; log z `"(hidden)"` → poprawne `Current Version ID`; deployment 100 %, inna wersja, podział, ostrzeżenie przed JSON, śmieci; `active-version` po `secret put`; `var` = 1, 0, brak. |
| `test/scheduled-config.test.ts` (+2) | Strategia `immediate` w konfiguracji i kontroli workflow. Brak oczekiwania na `any`. Każde oczekiwanie dłuższe niż 300 s. Kolejność dowodów w `enable`, `deploy-disabled`, `disable`, warunku wstępnym i rollbacku. `confirm` z prawdziwą wartością z #6 wykonany w bash. Sprawdzone na celowo zepsutym workflow: tryb `deferred`, `any`, rollback bez kontroli deploymentu i brak kontroli zmiennej powodują błąd testu. |

Wyniki: Worker 107/107 (0 pominiętych), typecheck OK, `wrangler deploy --dry-run` dla `wrangler.scheduled.toml`, `wrangler.toml` i `wrangler.stage2.toml` OK. Wrangler odczytuje `durable_objects.code_update_strategy = { mode: "immediate" }`.

## 5. Dalsze kroki (każdy po osobnej zgodzie)

1. Merge PR.
2. Akcja `check`, tylko odczyt. Oczekiwane: wersja `a8e5aeb6…` (potwierdzenie przyczyny).
3. `deploy-disabled`. Oczekiwane w logu: deployment 100 % na wersję z `secret put`, `OLX_CLOUD_ENABLED = "0"`, `/status` w tej samej wersji.
4. Dopiero potem `enable` z `WLACZ-AUTOMAT-OLX`.
