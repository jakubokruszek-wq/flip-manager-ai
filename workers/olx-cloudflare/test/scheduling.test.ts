/**
 * Finder fails an OLX job nobody claimed within 90 s. These tests pin the
 * scheduling policy that keeps claims inside that window, including late
 * alarms and a lost alarm recovered only by the one-minute Cron Trigger.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { budgetStop, canScrape, currentLedger, emptyLedger, nextUtcMidnight, remainingSafeMs, type BudgetLimits } from "../src/budget.ts";
import { loadCloudConfig } from "../src/config.ts";
import { nextAlarmDelayMs } from "../src/runner.ts";
import { createIdlePollBackoff } from "../../shared/idle-poll-backoff.ts";

const FINDER_UNCLAIMED_TIMEOUT_MS = 90_000;
const loaded = loadCloudConfig({ OLX_CLOUD_ENABLED: "1", OLX_WORKER_API_URL: "https://app.example", OLX_WORKER_SECRET: "x".repeat(40) });
assert.ok(loaded.ok);
const config = loaded.config;
const limits: BudgetLimits = { dailyBrowserLimitMs: 600_000, safeBrowserBudgetMs: 480_000, scrapeReserveMs: 35_000, sessionMaxMs: 45_000, keepAliveMs: 20_000, maxJobsPerDay: 0 };

test("default schedule: 20 s idle polling, immediate re-check after work", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  assert.equal(config.idlePollMs, 20_000);
  assert.equal(nextAlarmDelayMs({ outcome: "idle", stop: null }, config, now), 20_000);
  assert.equal(nextAlarmDelayMs({ outcome: "worked", stop: null }, config, now), 1_000);
  assert.equal(nextAlarmDelayMs({ outcome: "subrequest_limit", stop: null }, config, now), 1_000);
  const stop = budgetStop("OLX_CLOUD_BROWSER_BUDGET_EXHAUSTED", emptyLedger(now), now, limits);
  assert.equal(nextAlarmDelayMs({ outcome: "paused", stop }, config, now), 20_000, "fail_jobs keeps answering new jobs within 90 s");
  const quiet = nextAlarmDelayMs({ outcome: "paused", stop }, { ...config, onBudgetExhausted: "leave_queued" }, now);
  assert.equal(quiet, 15 * 60_000, "leave_queued sleeps (at most 15 min, re-checking after midnight)");
});

/** Small deterministic PRNG so the simulation is reproducible. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return state / 2 ** 32; };
}

type Simulation = { alarmLatenessMaxMs: number; cronLagMaxMs: number; loseAlarmAtMs: number | null; jobsPerHour: number; scrapeMs: number };

/** Claim latencies (ms) for jobs arriving at random over 24 h, plus the number of claim requests. */
function simulateWithClaims(options: Simulation, seed = 7): { latencies: number[]; claims: number } {
  const rand = random(seed);
  const day = 24 * 3_600_000;
  const arrivals: number[] = [];
  for (let t = 0; t < day; t += 3_600_000 / options.jobsPerHour) arrivals.push(t + rand() * (3_600_000 / options.jobsPerHour));
  arrivals.sort((a, b) => a - b);
  const latencies: number[] = [];
  let next = 0;
  let alarm: number | null = 0;
  let nextCron = 60_000;
  let pending: number[] = [];
  let index = 0;
  let claims = 0;
  // Same adaptive idle delay as the Durable Object: 20 s, then 40 s while the queue stays empty.
  const backoff = createIdlePollBackoff(config.idlePollMs, config.idlePollMaxMs);
  while (next < day) {
    // Alarm fires late by up to alarmLatenessMaxMs; a lost alarm never fires until a cron tick re-arms it.
    const cronAt = nextCron + rand() * options.cronLagMaxMs;
    const alarmAt: number = alarm === null ? Number.POSITIVE_INFINITY : alarm + rand() * options.alarmLatenessMaxMs;
    if (cronAt < alarmAt) {
      if (alarm === null) alarm = cronAt + 1_000;
      nextCron += 60_000;
      continue;
    }
    const now: number = alarmAt;
    while (index < arrivals.length && arrivals[index] <= now) pending.push(arrivals[index++]);
    const claimedNow = pending.slice(0, Math.min(config.maxHeldJobs, config.maxJobsPerInvocation));
    claims += claimedNow.length + 1; // each job's claim plus the empty one that ends the batch
    pending = pending.slice(claimedNow.length);
    for (const arrival of claimedNow) latencies.push(now - arrival);
    const worked = claimedNow.length > 0;
    const finishedAt: number = now + claimedNow.length * options.scrapeMs;
    if (options.loseAlarmAtMs !== null && now >= options.loseAlarmAtMs) {
      options = { ...options, loseAlarmAtMs: null };
      alarm = null;
      next = finishedAt;
      continue;
    }
    const idleDelayMs = backoff.currentDelayMs();
    if (worked) backoff.recordClaimWithJob(); else backoff.recordEmptyClaim();
    const nextAlarm = finishedAt + nextAlarmDelayMs({ outcome: worked ? "worked" : "idle", stop: null }, config, finishedAt, idleDelayMs);
    alarm = nextAlarm;
    next = nextAlarm;
  }
  return { latencies, claims };
}

function simulate(options: Simulation, seed = 7): number[] {
  return simulateWithClaims(options, seed).latencies;
}

test("normal operation: every job is claimed well within Finder's 90 s window despite late alarms", () => {
  const latencies = simulate({ alarmLatenessMaxMs: 15_000, cronLagMaxMs: 30_000, loseAlarmAtMs: null, jobsPerHour: 6, scrapeMs: 8_000 });
  const worst = Math.max(...latencies);
  if (process.env.OLX_SIM_REPORT) console.log(`worst=${worst}`);
  assert.ok(latencies.length > 100);
  assert.ok(worst < 60_000, `worst claim latency ${worst} ms`);
});

test("a lost alarm is re-armed by the next Cron Trigger: the job is still claimed before 90 s", () => {
  const latencies = simulate({ alarmLatenessMaxMs: 5_000, cronLagMaxMs: 25_000, loseAlarmAtMs: 6 * 3_600_000, jobsPerHour: 60, scrapeMs: 8_000 });
  const worst = Math.max(...latencies);
  if (process.env.OLX_SIM_REPORT) console.log(`worst=${worst}`);
  assert.ok(worst < FINDER_UNCLAIMED_TIMEOUT_MS, `worst claim latency ${worst} ms`);
});

test("bursts (a scan of several filters) are claimed together: held jobs no longer count as unclaimed", () => {
  const latencies = simulate({ alarmLatenessMaxMs: 15_000, cronLagMaxMs: 30_000, loseAlarmAtMs: null, jobsPerHour: 240, scrapeMs: 8_000 });
  assert.ok(Math.max(...latencies) < FINDER_UNCLAIMED_TIMEOUT_MS);
});

test("budget: a page is opened only while a full scrape reserve fits under the safe budget", () => {
  const now = Date.parse("2026-10-13T10:00:00Z");
  const ledger = { ...emptyLedger(now), browserMs: 445_000 };
  assert.equal(canScrape(ledger, now, null, limits), true);
  assert.equal(canScrape(ledger, now + 1_000, now, limits), false, "time of the open session counts");
  assert.equal(remainingSafeMs(ledger, now, null, limits), 35_000);
  assert.equal(canScrape({ ...ledger, browserMs: 0, stop: budgetStop("OLX_CLOUD_BROWSER_DAILY_LIMIT_429", ledger, now, limits) }, now, null, limits), false, "Cloudflare's 429 is final for the day");
  assert.equal(nextUtcMidnight(now), "2026-10-14T00:00:00.000Z");
  // Worst-case accounting stays below the plan limit: safe budget + one session overrun + keep_alive.
  assert.ok(limits.safeBrowserBudgetMs + limits.sessionMaxMs + limits.keepAliveMs <= limits.dailyBrowserLimitMs);
});

test("budget: a new UTC day resets the ledger; an orphaned session is charged at its worst case", () => {
  const now = Date.parse("2026-10-13T00:00:05Z");
  const stale = { ...emptyLedger(Date.parse("2026-10-12T23:59:00Z")), browserMs: 600_000 };
  assert.equal(currentLedger(stale, now, limits).browserMs, 0);
  const orphan = { ...emptyLedger(now), browserMs: 1_000, openSession: { startedAt: now - 120_000, sessionId: "s" } };
  assert.equal(currentLedger(orphan, now, limits).browserMs, 1_000 + 45_000 + 20_000);
});

test("claim volume: adaptive idle polling roughly halves the requests sent to Vercel/Supabase", () => {
  const typical = { alarmLatenessMaxMs: 2_000, cronLagMaxMs: 10_000, loseAlarmAtMs: null, jobsPerHour: 2, scrapeMs: 8_000 };
  const { claims, latencies } = simulateWithClaims(typical);
  if (process.env.OLX_SIM_REPORT) console.log(`claims/day=${claims} worst=${Math.max(...latencies)}`);
  assert.ok(claims < 2_400, `claims per day: ${claims} (fixed 20 s polling would be ~4 320)`);
  assert.ok(Math.max(...latencies) < 60_000);
});
