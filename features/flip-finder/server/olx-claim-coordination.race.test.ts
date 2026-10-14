/**
 * Real concurrency of the three OLX claims on a REAL PostgreSQL server (one
 * psql process = one server connection), migration 20261017120000:
 *   claim_olx_scan_job (regular/local worker), claim_olx_scan_job_selective
 *   (stage2 test) and claim_scheduled_finder_olx_job (scheduled Worker).
 *
 * PGlite cannot show this: it runs every query through one connection, so a
 * second session can never block on a lock held by an open transaction. Here
 * one session claims inside an open transaction, the other one is observed
 * (pg_locks) WAITING on the shared advisory lock, and only after the first
 * commits does it decide -- on the committed state. A control test runs the
 * same interleaving without 20261017 and shows the race was real.
 *
 * Requires OLX_RACE_DATABASE_URL: a disposable local server (CI: the postgres
 * service of .github/workflows/olx-claim-coordination.yml). Every test creates
 * and drops its own database. Any non-local host is refused.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHAIN_OTHER, ENABLE_AUTOMATION, PR16_MIGRATIONS, PRODUCTION_MIGRATIONS, USAGE_OK, chainSql, jobSql } from "./olx-migration-chain.fixture.ts";

const ADMIN_URL = process.env.OLX_RACE_DATABASE_URL ?? "";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const skip = !ADMIN_URL
  ? "OLX_RACE_DATABASE_URL not set (real PostgreSQL required; CI: workflow olx-claim-coordination.yml)"
  : !LOCAL_HOSTS.has(new URL(ADMIN_URL).hostname) ? "OLX_RACE_DATABASE_URL must point at a local disposable server" : false;
// CI sets OLX_RACE_REQUIRED=1: there a missing server is a failure, never a silent skip.
if (skip && process.env.OLX_RACE_REQUIRED === "1") throw new Error(`real-PostgreSQL race tests required but not runnable: ${skip}`);

const OLD = "local-worker";
const STAGE2 = "cloudflare-olx-stage2";
const SCHEDULED = "cloudflare-olx-scheduled";
const WITHOUT_COORDINATION = PR16_MIGRATIONS.filter((file) => !file.startsWith("20261017"));

class Session {
  private readonly proc: ChildProcessWithoutNullStreams;
  private out = "";
  private err = "";
  private seq = 0;
  private waiters: Array<() => void> = [];
  pid = 0;

  constructor(url: string) {
    this.proc = spawn("psql", [url, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=0"], { stdio: ["pipe", "pipe", "pipe"] });
    const wake = () => { for (const waiter of [...this.waiters]) waiter(); };
    this.proc.stdout.on("data", (chunk) => { this.out += String(chunk); wake(); });
    this.proc.stderr.on("data", (chunk) => { this.err += String(chunk); wake(); });
  }

  static async open(url: string): Promise<Session> {
    const session = new Session(url);
    session.pid = Number(await session.query("select pg_backend_pid();"));
    return session;
  }

  /** Sends SQL; resolves when the server answered (stdout and stderr, both delimited). */
  send(sql: string): Promise<{ out: string; err: string }> {
    const marker = `__done_${++this.seq}__\n`;
    this.proc.stdin.write(`${sql}\n\\echo ${marker.trim()}\n\\warn ${marker.trim()}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer within 60 s: ${sql.slice(0, 120)}`)), 60_000);
      timer.unref();
      const check = () => {
        const outAt = this.out.indexOf(marker);
        const errAt = this.err.indexOf(marker);
        if (outAt < 0 || errAt < 0) return;
        const result = { out: this.out.slice(0, outAt).trim(), err: this.err.slice(0, errAt).trim() };
        this.out = this.out.slice(outAt + marker.length);
        this.err = this.err.slice(errAt + marker.length);
        this.waiters = this.waiters.filter((waiter) => waiter !== check);
        clearTimeout(timer);
        resolve(result);
      };
      this.waiters.push(check);
      check();
    });
  }

  async query(sql: string): Promise<string> {
    const result = await this.send(sql);
    if (result.err) throw new Error(result.err);
    return result.out;
  }

  /** Ends the connection, also when a query is still waiting (a failed assertion). */
  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

let counter = 0;

/** One-shot admin statement (no interactive session that could outlive a failed test). */
function admin(sql: string) {
  const result = spawnSync("psql", [ADMIN_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
}

async function withDatabase(migrations: readonly string[], body: (url: string, observer: Session) => Promise<void>) {
  const name = `olx_claim_race_${process.pid}_${++counter}`;
  admin(`create database ${name};`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "olx-race-")), "schema.sql");
  fs.writeFileSync(file, `${chainSql([...PRODUCTION_MIGRATIONS, ...migrations])}\n;\n${ENABLE_AUTOMATION}\n`);
  const applied = spawnSync("psql", [url.toString(), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file], { encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
  const observer = await Session.open(url.toString());
  try {
    await body(url.toString(), observer);
  } finally {
    observer.close();
    admin(`drop database if exists ${name} with (force);`);
  }
}

/** Waits until the session is blocked on a lock it has not been granted. */
async function waitUntilBlocked(observer: Session, session: Session) {
  for (let i = 0; i < 200; i += 1) {
    if (await observer.query(`select count(*) from pg_locks where pid = ${session.pid} and not granted;`) === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`session ${session.pid} never waited on a lock`);
}

/** The answer of a call that must NOT block: resolves within the time limit. */
async function answersWithoutWaiting<T>(promise: Promise<T>): Promise<T> {
  return await Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("blocked")), 3_000))]);
}

const oldClaim = (worker = OLD) => `select idempotency_key from public.claim_olx_scan_job('${worker}', 120);`;
const selectiveClaim = (key: string) => `select idempotency_key from public.claim_olx_scan_job_selective('${STAGE2}', (select id from public.olx_scan_jobs where idempotency_key = '${key}'), 120);`;
const scheduledClaim = () => `select coalesce(r->'job'->>'idempotency_key', r->>'reason') from public.claim_scheduled_finder_olx_job('${SCHEDULED}', 120, '${USAGE_OK}'::jsonb) r;`;
const running = async (observer: Session) => (await observer.query(
  `select idempotency_key || ':' || worker_id from public.olx_scan_jobs where status = 'running' and leased_until > now() order by idempotency_key;`)).split("\n").filter(Boolean);

async function seedStandard(observer: Session) {
  await observer.query([
    jobSql({ key: "m1-manual", requestedBy: "manual", ageMinutes: 30 }),
    jobSql({ key: "m2-manual", requestedBy: null, ageMinutes: 20 }),
    jobSql({ key: "s1-auto", requestedBy: "scheduler", ageMinutes: 10 }),
  ].join("\n"));
}

test("control, WITHOUT 20261017: an old and a new claim at the same moment both start a job; the old one takes and requeues automatic jobs", { skip }, async () => {
  await withDatabase(WITHOUT_COORDINATION, async (url, observer) => {
    await seedStandard(observer);
    const a = await Session.open(url);
    const b = await Session.open(url);
    try {
      await a.query("begin;");
      assert.equal(await a.query(oldClaim()), "m1-manual");
      // The scheduled claim cannot see A's uncommitted claim and does not wait for it.
      assert.equal(await answersWithoutWaiting(b.query(scheduledClaim())), "s1-auto");
      await a.query("commit;");
      assert.deepEqual(await running(observer), [`m1-manual:${OLD}`, `s1-auto:${SCHEDULED}`], "two browsers at once: the race is real");

      // The old claim's lease recovery requeues the automatic job, and the old worker then takes it.
      await observer.query(`update public.olx_scan_jobs set status = 'completed', leased_until = null where idempotency_key = 'm1-manual';
        update public.olx_scan_jobs set leased_until = now() - interval '1 minute' where idempotency_key = 's1-auto';
        update public.olx_scan_jobs set status = 'completed' where idempotency_key = 'm2-manual';`);
      assert.equal(await a.query(oldClaim()), "s1-auto", "unauthorized retry of an automatic job by the regular worker");
      assert.equal(await observer.query(`select attempts || ':' || worker_id from public.olx_scan_jobs where idempotency_key = 's1-auto';`), `2:${OLD}`);
    } finally {
      a.close();
      b.close();
    }
  });
});

test("old claim in flight: the scheduled claim WAITS on the shared lock, then sees the committed job and refuses (OLX_JOB_RUNNING)", { skip }, async () => {
  await withDatabase(PR16_MIGRATIONS, async (url, observer) => {
    await seedStandard(observer);
    const a = await Session.open(url);
    const b = await Session.open(url);
    try {
      await a.query("begin;");
      assert.equal(await a.query(oldClaim()), "m1-manual");
      const pending = b.query(scheduledClaim());
      await waitUntilBlocked(observer, b);
      await a.query("commit;");
      assert.equal(await pending, "OLX_JOB_RUNNING");
      assert.deepEqual(await running(observer), [`m1-manual:${OLD}`]);
    } finally {
      a.close();
      b.close();
    }
  });
});

test("scheduled claim in flight: the old and the selective claim WAIT, then hand out nothing; manual jobs run once the automatic one ends", { skip }, async () => {
  await withDatabase(PR16_MIGRATIONS, async (url, observer) => {
    await seedStandard(observer);
    const a = await Session.open(url);
    const b = await Session.open(url);
    const c = await Session.open(url);
    try {
      await a.query("begin;");
      assert.equal(await a.query(scheduledClaim()), "s1-auto");
      const old = b.query(oldClaim());
      const selective = c.query(selectiveClaim("m2-manual"));
      await waitUntilBlocked(observer, b);
      await waitUntilBlocked(observer, c);
      await a.query("commit;");
      assert.equal(await old, "", "nothing next to a running automatic job");
      assert.equal(await selective, "");
      assert.deepEqual(await running(observer), [`s1-auto:${SCHEDULED}`]);

      await observer.query(`update public.olx_scan_jobs set status = 'completed', finished_at = now(), leased_until = null where idempotency_key = 's1-auto';`);
      assert.equal(await b.query(oldClaim()), "m1-manual", "manual scans keep working");
      assert.equal(await c.query(selectiveClaim("m2-manual")), "m2-manual");
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });
});

test("selective claim in flight: the scheduled claim waits, then refuses", { skip }, async () => {
  await withDatabase(PR16_MIGRATIONS, async (url, observer) => {
    await seedStandard(observer);
    const a = await Session.open(url);
    const b = await Session.open(url);
    try {
      await a.query("begin;");
      assert.equal(await a.query(selectiveClaim("m2-manual")), "m2-manual");
      const pending = b.query(scheduledClaim());
      await waitUntilBlocked(observer, b);
      await a.query("commit;");
      assert.equal(await pending, "OLX_JOB_RUNNING");
    } finally {
      a.close();
      b.close();
    }
  });
});

test("two regular workers: serialized by the lock but still both served, as before (manual scans unchanged)", { skip }, async () => {
  await withDatabase(PR16_MIGRATIONS, async (url, observer) => {
    await seedStandard(observer);
    const a = await Session.open(url);
    const b = await Session.open(url);
    try {
      await a.query("begin;");
      assert.equal(await a.query(oldClaim("local-a")), "m1-manual");
      const pending = b.query(oldClaim("local-b"));
      await waitUntilBlocked(observer, b);
      await a.query("commit;");
      assert.equal(await pending, "m2-manual");
      assert.deepEqual(await running(observer), ["m1-manual:local-a", "m2-manual:local-b"]);
    } finally {
      a.close();
      b.close();
    }
  });
});

test("storm: 9 connections (3 of each claim) released together, 15 rounds; invariants hold every round", { skip }, async () => {
  await withDatabase(PR16_MIGRATIONS, async (url, observer) => {
    const sessions = await Promise.all(Array.from({ length: 9 }, () => Session.open(url)));
    try {
      for (let round = 0; round < 15; round += 1) {
        await observer.query(`delete from public.olx_scan_jobs; delete from public.source_scans;
          ${jobSql({ key: "a-manual", requestedBy: "manual", ageMinutes: 9 })}
          ${jobSql({ key: "b-auto", requestedBy: "scheduler", ageMinutes: 8 })}
          ${jobSql({ key: "c-manual", requestedBy: null, ageMinutes: 7, filter: CHAIN_OTHER })}
          ${jobSql({ key: "d-auto", requestedBy: "scheduler", ageMinutes: 6, filter: CHAIN_OTHER })}
          ${jobSql({ key: "e-manual", requestedBy: "manual", ageMinutes: 5 })}`);
        // Alternate who arrives first so every pairing is exercised.
        const calls = sessions.map((_, index) => {
          const kind = (index + round) % 3;
          return kind === 0 ? oldClaim(`local-${index}`) : kind === 1 ? selectiveClaim(round % 2 ? "c-manual" : "e-manual") : scheduledClaim();
        });
        const answers = await Promise.all(sessions.map((session, index) => session.send(calls[index])));
        for (const answer of answers) assert.equal(answer.err, "", answer.err);
        const rows = (await observer.query(`select idempotency_key || '|' || coalesce(worker_id, '') || '|' || attempts || '|' || status from public.olx_scan_jobs order by idempotency_key;`))
          .split("\n").map((line) => line.split("|"));
        const live = rows.filter(([, , , status]) => status === "running");
        const autoLive = live.filter(([key]) => key.endsWith("-auto"));
        assert.ok(autoLive.every(([, worker]) => worker === SCHEDULED), `round ${round}: an automatic job was taken by a non-scheduled worker: ${JSON.stringify(rows)}`);
        assert.ok(live.filter(([key]) => !key.endsWith("-auto")).every(([, worker]) => worker !== SCHEDULED), `round ${round}: the scheduled Worker took a manual job`);
        assert.ok(autoLive.length === 0 || live.length === 1, `round ${round}: an automatic job runs next to another job: ${JSON.stringify(live)}`);
        assert.ok(autoLive.length <= 1, `round ${round}`);
        assert.ok(rows.every(([, , attempts]) => Number(attempts) <= 1), `round ${round}: a job was claimed twice`);
        assert.ok(live.length >= 1, `round ${round}: somebody must have been served`);
      }
    } finally {
      for (const session of sessions) session.close();
    }
  });
});

test("expired lease under concurrency: regular claim, scheduled claim and a late heartbeat at once -- the automatic job is neither requeued, retaken nor revived", { skip }, async () => {
  await withDatabase(PR16_MIGRATIONS, async (url, observer) => {
    await observer.query([
      jobSql({ key: "s1-auto", requestedBy: "scheduler", status: "running", ageMinutes: 20, leasedForSeconds: -60, workerId: SCHEDULED }),
      jobSql({ key: "m1-manual", requestedBy: "manual", ageMinutes: 5 }),
    ].join("\n"));
    const [a, b, c] = await Promise.all([Session.open(url), Session.open(url), Session.open(url)]);
    try {
      const [regular, scheduled, heartbeat] = await Promise.all([
        a.send(oldClaim()),
        b.send(scheduledClaim()),
        c.send(`update public.olx_scan_jobs set leased_until = now() + interval '2 minutes', heartbeat_at = now() where idempotency_key = 's1-auto' and status = 'running';`),
      ]);
      assert.equal(regular.err, "");
      assert.equal(scheduled.err, "");
      assert.match(heartbeat.err, /OLX_SCHEDULED_JOB_LEASE_EXPIRED/);
      assert.equal(regular.out, "m1-manual", "the regular worker is not blocked by a dead automatic lease");
      assert.ok(["OLX_JOB_RUNNING", "NO_DUE_JOB"].includes(scheduled.out), `never the expired job again: ${scheduled.out}`);
      assert.equal(await observer.query(`select status || ':' || attempts || ':' || worker_id from public.olx_scan_jobs where idempotency_key = 's1-auto';`), `running:1:${SCHEDULED}`);
      await observer.query(`update public.olx_scan_jobs set leased_until = now() - interval '11 minutes' where idempotency_key = 's1-auto';`);
      await observer.query(`select public.expire_stale_scheduled_finder_olx_jobs();`);
      assert.equal(await observer.query(`select status || ':' || error_code || ':' || attempts from public.olx_scan_jobs where idempotency_key = 's1-auto';`), "failed:OLX_SCHEDULED_JOB_LEASE_EXPIRED:1");
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });
});
