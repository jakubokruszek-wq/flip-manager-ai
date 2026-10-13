import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

/**
 * Offline check of the pg_cron change draft on a real PostgreSQL engine with a
 * minimal stand-in for pg_cron's catalog (cron.job + cron.alter_job). It
 * proves the SQL only re-schedules the two Finder jobs; it does not prove
 * anything about the Production database, which is changed only by hand.
 */
const FORWARD = readFileSync("scripts/finder-cron-every-5-minutes.sql", "utf8");
const ROLLBACK = readFileSync("scripts/finder-cron-every-5-minutes.rollback.sql", "utf8");
const COMMAND = "SELECT net.http_post(url := 'https://flip-manager-ai.vercel.app/api/jobs/x')";

async function cronDb(jobs: Array<[string, string]>) {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
    CREATE FUNCTION cron.alter_job(job_id bigint, schedule text default null) RETURNS void LANGUAGE sql
      AS 'UPDATE cron.job SET schedule = coalesce(alter_job.schedule, cron.job.schedule) WHERE jobid = job_id';
  `);
  // The draft checks pg_extension; PGlite has no pg_cron, so expose a view under that exact name in a schema searched first.
  await db.exec(`CREATE SCHEMA shim; CREATE VIEW shim.pg_extension AS SELECT 'pg_cron'::name AS extname; SET search_path = shim, public, pg_catalog;`);
  for (const [name, schedule] of jobs) await db.query("INSERT INTO cron.job (jobname, schedule, command) VALUES ($1, $2, $3)", [name, schedule, COMMAND]);
  return db;
}

const schedules = async (db: PGlite) => Object.fromEntries((await db.query<{ jobname: string; schedule: string }>("SELECT jobname, schedule FROM cron.job ORDER BY jobname")).rows.map((row) => [row.jobname, row.schedule]));

test("forward draft moves only the two Finder jobs from every minute to every 5 minutes; rollback restores them", async () => {
  const db = await cronDb([["finder-scan-scheduler", "* * * * *"], ["finder-scan-continuation", "* * * * *"], ["facebook-watch-scheduler", "* * * * *"], ["price-radar-scan-scheduler", "*/10 * * * *"]]);
  try {
    await db.exec(FORWARD);
    assert.deepEqual(await schedules(db), { "facebook-watch-scheduler": "* * * * *", "finder-scan-continuation": "*/5 * * * *", "finder-scan-scheduler": "*/5 * * * *", "price-radar-scan-scheduler": "*/10 * * * *" });
    const commands = (await db.query<{ command: string }>("SELECT DISTINCT command FROM cron.job")).rows;
    assert.deepEqual(commands, [{ command: COMMAND }], "job commands are untouched");
    await db.exec(FORWARD); // idempotent
    assert.equal((await schedules(db))["finder-scan-scheduler"], "*/5 * * * *");
    await db.exec(ROLLBACK);
    assert.deepEqual(await schedules(db), { "facebook-watch-scheduler": "* * * * *", "finder-scan-continuation": "* * * * *", "finder-scan-scheduler": "* * * * *", "price-radar-scan-scheduler": "*/10 * * * *" });
  } finally { await db.close(); }
});

test("a missing or duplicated Finder job aborts before any change", async () => {
  for (const jobs of [[["finder-scan-scheduler", "* * * * *"]], [["finder-scan-scheduler", "* * * * *"], ["finder-scan-scheduler", "* * * * *"], ["finder-scan-continuation", "* * * * *"]]] as Array<Array<[string, string]>>) {
    const db = await cronDb(jobs);
    try {
      await assert.rejects(db.exec(FORWARD), /Expected exactly one cron job named/);
      await db.exec("ROLLBACK");
      assert.ok(Object.values(await schedules(db)).every((schedule) => schedule === "* * * * *"), "nothing changed");
    } finally { await db.close(); }
  }
});

test("daily call budget: 2 jobs x 288 = 576 instead of 2 x 1440 = 2880; no secret in either draft", () => {
  assert.equal(2 * (24 * 60) / 5, 576);
  assert.equal(2 * 24 * 60, 2880);
  for (const sql of [FORWARD, ROLLBACK]) {
    const statements = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    assert.doesNotMatch(statements, /Bearer|decrypted_secret|vault\./i);
    assert.doesNotMatch(statements, /cron\.schedule\(|cron\.unschedule\(|DELETE|DROP|INSERT|facebook|radar/i);
  }
});
