# Etap retencji (oddzielny od wdrożenia Findera)

Pliki w tym katalogu **nie są migracjami** i nie zostaną zastosowane przez `supabase db push`
ani przez integrację Git. Każdy krok wymaga osobnej zgody operatora.

1. `01_add_finder_operational_retention.sql` — tabele statystyk dziennych, `finder_retention_report()`,
   `finder_retention_run(dry_run)`. Samo zastosowanie niczego nie usuwa.
2. `select * from public.finder_retention_report();` oraz `select * from public.finder_retention_run(true);` — tylko raport.
3. `02_fix_facebook_worker_nonce_cleanup_grant.sql` — po zastosowaniu aplikacja zacznie sama usuwać wygasłe nonce Facebook Workera.
4. Pierwszy rzeczywisty przebieg `finder_retention_run(false, 500, 10)`.
5. `03_configure_finder_retention_cron.sql` — najpierw codzienny dry-run, później (po akceptacji) przebieg co 15 minut.
6. `VACUUM FULL` — wyłącznie w oknie serwisowym, nigdy automatycznie.

Testy na prawdziwym PostgreSQL: `features/flip-finder/retention/operational-retention.rpc.test.ts`.
