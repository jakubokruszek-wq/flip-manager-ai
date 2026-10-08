# Price Radar lease concurrency check (local PostgreSQL only)

The checkout has no `psql`, `pg_isready`, or local PostgreSQL server. The PGlite test executes the draft SQL in embedded PostgreSQL, but it does not prove overlapping transactions on a real PostgreSQL server.

Before enabling the Radar scheduler, run this check only against a new, isolated local PostgreSQL test database after applying the local draft migration. Do not run it against Production. Use a fresh test owner that exists in `auth.users` and is not used by other tests.

Run Session A first and keep its transaction open during the 10-second sleep:

```sql
begin;
select * from public.claim_price_radar_run(
  '00000000-0000-4000-8000-000000000071'::uuid,
  '{"sourceQueue":[],"currentSourceIndex":0,"perSourceCursor":{},"sourceStatuses":{},"sourceErrors":{},"buffer":[],"bufferOffset":0}'::jsonb,
  120
);
select pg_sleep(10);
commit;
```

Start Session B while Session A is sleeping, using the same owner and checkpoint:

```sql
begin;
select * from public.claim_price_radar_run(
  '00000000-0000-4000-8000-000000000071'::uuid,
  '{"sourceQueue":[],"currentSourceIndex":0,"perSourceCursor":{},"sourceStatuses":{},"sourceErrors":{},"buffer":[],"bufferOffset":0}'::jsonb,
  120
);
commit;
```

Expected: Session A returns one run ID and lease token. Session B blocks until Session A commits, then returns zero rows. Verify that exactly one active run exists for the test owner:

```sql
select count(*) as active_runs
from public.price_radar_runs
where owner_id = '00000000-0000-4000-8000-000000000071'::uuid
  and status in ('pending', 'running');
```

Expected `active_runs = 1`. The current PGlite test checks the sequential claim, reclaim, and stale-token behaviors; this separate two-session check is still required for real PostgreSQL transaction concurrency.
