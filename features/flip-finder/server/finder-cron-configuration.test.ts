import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("configuration draft schedules only Finder jobs with Vault references and aborts if prerequisites are missing", () => {
  const sql = readFileSync("scripts/configure-finder-cron.sql", "utf8");
  assert.equal((sql.match(/SELECT cron\.schedule\(/g) ?? []).length, 2);
  for (const name of ["finder-scan-scheduler", "finder-scan-continuation"]) {
    assert.ok(sql.includes(`cron.schedule('${name}', '*/5 * * * *'`));
    assert.ok(sql.includes(`https://flip-manager-ai.vercel.app/api/jobs/${name}`));
  }
  assert.ok(sql.includes("FROM vault.decrypted_secrets WHERE name = 'finder_cron_secret'"));
  assert.match(sql, /extname = 'pg_cron'[\s\S]+RAISE EXCEPTION/);
  assert.match(sql, /extname = 'pg_net'[\s\S]+RAISE EXCEPTION/);
  assert.match(sql, /to_regclass\('vault.decrypted_secrets'\)/);
  assert.doesNotMatch(sql, /CREATE EXTENSION|ALTER TABLE|facebook_scan_jobs|olx_scan_jobs|INSERT INTO public\.listings/i);
  assert.doesNotMatch(sql, /Bearer [a-zA-Z0-9._-]{10,}/);
});

test("confirmed Supabase driver disables duplicate scheduled Actions but keeps manual OIDC diagnostics", () => {
  for (const name of ["finder-scan-scheduler", "finder-scan-continuation"]) {
    const workflow = readFileSync(`.github/workflows/${name}.yml`, "utf8");
    assert.match(workflow, /github.event_name == 'workflow_dispatch' \|\| vars.FINDER_SCHEDULER_DRIVER != 'supabase-cron'/);
    assert.match(workflow, /id-token: write/);
    assert.match(workflow, /cancel-in-progress: false/);
  }
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
  assert.equal(vercel.crons.length, 1);
  assert.match(vercel.crons[0].path, /facebook/);
  assert.equal(vercel.crons[0].schedule, "0 8 * * *");
});

test("PostgreSQL parses the draft guard and both HTTP job commands offline; missing extensions fail closed", async () => {
  const db = new PGlite();
  const sql = readFileSync("scripts/configure-finder-cron.sql", "utf8");
  try {
    const guard = sql.match(/DO \$preflight\$[\s\S]+?\$preflight\$;/)![0];
    await assert.rejects(db.exec(guard), /pg_cron is not available/, "the actual PL/pgSQL block must parse, then reject missing prerequisites");
    // Only signature stubs, not a claim that pg_net/pg_cron are available.
    // No HTTP request can be made in this offline SQL syntax check.
    await db.exec(`CREATE SCHEMA net; CREATE SCHEMA vault;
      CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
      INSERT INTO vault.decrypted_secrets VALUES ('finder_cron_secret', 'offline-fixture');
      CREATE FUNCTION net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
      RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint';`);
    const commands = [...sql.matchAll(/\$job\$([\s\S]+?)\$job\$/g)].map((match) => match[1]);
    assert.equal(commands.length, 2);
    for (const command of commands) assert.equal((await db.query<{ http_post: number }>(command)).rows[0].http_post, 1);
  } finally { await db.close(); }
});
