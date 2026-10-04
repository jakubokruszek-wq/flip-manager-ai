import assert from "node:assert/strict";
import test from "node:test";
import { overallFinishedAt } from "./scan-progress.ts";
import type { ScanWorkUnit } from "@/features/flip-finder/scan-progress";

/**
 * Independent review finding on the CAS commit (0aac7d9): scanTimestamp
 * correctly explains why several sources' finished_at cluster near
 * startedAt+timeoutMs (not evidence of duplicate execution), but
 * getScanProgress's own finishedAt/elapsedMs previously took a naive
 * MAX(finished_at) across source_scans rows -- which, for the real
 * background-worker path where every prepared row shares ONE reservation
 * started_at, silently reports only the single longest source's own
 * duration as the whole run's elapsed time, discarding every other
 * source's time entirely. Reproduced here with the real durations from
 * Production run a8752aef (13 sequential sources, true total ~189s):
 * the old MAX-based logic would have reported ~19.7s.
 */

function unit(source: string, startedAt: string, finishedAtOffsetMs: number, startedAtIso = startedAt): ScanWorkUnit {
  return {
    id: `scan-${source}`,
    source: source as ScanWorkUnit["source"],
    status: "completed",
    startedAt: startedAtIso,
    finishedAt: new Date(Date.parse(startedAtIso) + finishedAtOffsetMs).toISOString(),
    scannedCount: 0, matchedCount: 0, normalizedCount: 0, errorMessage: null,
  };
}

const RESERVATION = "2026-10-04T10:02:36.008081Z";

test("when every unit shares one reservation started_at (the real background-worker path), the overall finish sums each unit's own duration instead of taking their max", () => {
  // The real per-source durations (finished_at - started_at) from Production
  // run a8752aef, every one of them sharing this exact reservation moment.
  const durationsMs = [386, 1704, 2591, 7816, 18793, 19212, 19727, 19729, 19731, 19735, 19735, 19737, 19744];
  const units = durationsMs.map((ms, index) => unit(`source-${index}`, RESERVATION, ms));
  const totalMs = durationsMs.reduce((total, ms) => total + ms, 0);

  const result = overallFinishedAt(units);
  assert.equal(result, new Date(Date.parse(RESERVATION) + totalMs).toISOString());

  const naiveMax = Math.max(...durationsMs);
  assert.notEqual(result, new Date(Date.parse(RESERVATION) + naiveMax).toISOString(), "must not regress to reporting only the single longest source's own duration (~20s instead of the true ~189s)");
  assert.ok(Date.parse(result!) - Date.parse(RESERVATION) > 180_000, "the true total must reflect all 13 sequential sources' queued time, not just the slowest one");
});

test("a single-unit run is unaffected: the overall finish equals that one unit's own finishedAt exactly as before", () => {
  const units = [unit("otodom", RESERVATION, 2_591)];
  assert.equal(overallFinishedAt(units), units[0]!.finishedAt);
});

test("units that do NOT share one started_at (the legacy/non-prepared insert path, where each row's own started_at is already its own true start) keep the original max-based finish", () => {
  const units = [
    unit("otodom", "2026-10-04T10:00:00.000Z", 2_000),
    unit("morizon", "2026-10-04T10:00:02.500Z", 3_000),
  ];
  // Each row's own started_at is already its real wall-clock start here, so
  // finishedAt already reflects each row's true finish -- the latest one
  // truly is the overall finish, exactly like before this fix.
  assert.equal(overallFinishedAt(units), units[1]!.finishedAt);
});

test("a still-running (non-terminal) unit is excluded from the sum, and a run with no terminal units at all returns null", () => {
  const running: ScanWorkUnit = { id: "scan-running", source: "otodom", status: "running", startedAt: RESERVATION, finishedAt: null, scannedCount: 0, matchedCount: 0, normalizedCount: 0, errorMessage: null };
  assert.equal(overallFinishedAt([running]), null);

  const completed = unit("morizon", RESERVATION, 5_000);
  const result = overallFinishedAt([running, completed]);
  assert.equal(result, completed.finishedAt, "only the terminal unit's own duration contributes; a still-running unit has no finishedAt to sum");
});
