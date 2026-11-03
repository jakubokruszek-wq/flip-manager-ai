import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("the independent timer is private, idempotent, credential-rotatable and limited to the existing Radar endpoint", async () => {
  const db = new PGlite();
  try {
    // Vault/cron contracts are faked; the actual migration function and ACL
    // execute in Postgres. No external request or real credential is used.
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema vault; create schema cron;
      create table vault.secrets(id uuid primary key default gen_random_uuid(),name text unique,secret text);
      create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
      create function vault.create_secret(new_secret text,new_name text,new_description text default '',new_key_id uuid default null)
      returns uuid language sql as $$ insert into vault.secrets(name,secret) values(new_name,new_secret) returning id $$;
      create function vault.update_secret(secret_id uuid,new_secret text,new_name text default null,new_description text default null,new_key_id uuid default null)
      returns void language sql as $$ update vault.secrets set secret=new_secret where id=secret_id $$;
      create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text,active boolean default true,username text default current_user);
      create function cron.schedule(job_name text,job_schedule text,job_command text) returns bigint language sql as $$
        insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command)
        on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command,active=true returning jobid $$;
      insert into cron.job(jobname,schedule,command) values('unrelated-job','0 2 * * *','select 1');
    `);
    const directory = path.join(process.cwd(), "supabase/migrations");
    const migration = fs.readdirSync(directory).find((name) => name.endsWith("_price_radar_independent_watchdog.sql"));
    assert.ok(migration);
    await db.exec(fs.readFileSync(path.join(directory, migration), "utf8"));
    for (const role of ["anon", "authenticated"]) {
      const permission = await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.ensure_price_radar_watchdog(text)','EXECUTE') as allowed", [role]);
      assert.equal(permission.rows[0].allowed, false);
    }
    await db.exec("set role service_role");
    await db.query("select public.ensure_price_radar_watchdog($1)", ["fixture-secret-first"]);
    await db.query("select public.ensure_price_radar_watchdog($1)", ["fixture-secret-first"]);
    await db.query("select public.ensure_price_radar_watchdog($1)", ["fixture-secret-rotated"]);
    await db.exec("reset role");
    const jobs = await db.query<{ jobname: string; command: string; schedule: string }>("select jobname,command,schedule from cron.job order by jobname");
    assert.equal(jobs.rows.length, 2, "repeated registration never adds duplicate timers or changes another job");
    const timer = jobs.rows.find((row) => row.jobname === "price-radar-watchdog")!;
    assert.equal(timer.schedule, "* * * * *");
    assert.ok(timer.command.includes("https://flip-manager-ai.vercel.app/api/jobs/price-radar-collect"));
    assert.ok(timer.command.includes("'x-radar-watchdog','1'"));
    assert.ok(timer.command.includes("vault.decrypted_secrets"));
    assert.ok(!timer.command.includes("fixture-secret"));
    assert.equal(jobs.rows.find((row) => row.jobname === "unrelated-job")?.command, "select 1");
    const stored = await db.query<{ secret: string }>("select secret from vault.secrets");
    assert.deepEqual(stored.rows, [{ secret: "fixture-secret-rotated" }]);
    for (const invalid of [null, "", "bad\nheader"]) await assert.rejects(db.query("select public.ensure_price_radar_watchdog($1)", [invalid]), /INVALID_CONFIGURATION/);
  } finally { await db.close(); }
});
