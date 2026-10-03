@AGENTS.md

## Working directory

- Praca wyłącznie w katalogu głównego repo `flip-manager` (`C:\Users\mokru\Desktop\flip-manager`).
- Przed jakimikolwiek zmianami sprawdź `git rev-parse --show-toplevel` i upewnij się, że wskazuje dokładnie na ten katalog; jeśli nie, przerwij bez zmian.
- Zakaz tworzenia lub przełączania git worktree oraz edytowania sąsiednich checkoutów/repozytoriów.
- Zakaz `git reset --hard`, `git stash` i nadpisywania zastanych, niezapisanych zmian użytkownika.
- Zakaz usuwania jakiegokolwiek katalogu na Pulpicie (w tym innych `flip-manager*`) bez wcześniejszego sprawdzenia `git worktree list`, statusu i commitów każdego z nich względem głównego repo — usuwaj wyłącznie `git worktree remove` na dokładnie rozpoznanym, czystym worktree, którego wszystkie commity są już w głównym repo.
