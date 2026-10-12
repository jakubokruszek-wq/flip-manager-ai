import assert from "node:assert/strict";
import test from "node:test";
import { radarRunActivity } from "./run-presentation.ts";

const now = Date.parse("2026-10-13T00:00:00.000Z");

function run(overrides: Record<string, unknown> = {}) {
  return {
    status: "running",
    leaseUntil: "2026-10-13T00:01:00.000Z",
    lastProgressAt: "2026-10-12T23:59:00.000Z",
    sourceStatuses: { olx: "completed", domiporta: "running", oferty_net: "pending", morizon: "completed" },
    checkpoint: { sourceQueue: ["olx", "domiporta", "oferty_net", "morizon"], currentSourceIndex: 1 },
    ...overrides,
  };
}

test("active lease shows the source actually running, last durable progress and unfinished source count", () => {
  const activity = radarRunActivity(run() as never, now);
  assert.equal(activity.status, "Skanowanie trwa — domiporta");
  assert.equal(activity.currentSource, "domiporta");
  assert.equal(activity.remainingSources, 2, "the running and pending sources remain; completed sources do not");
  assert.equal(activity.hasActiveLease, true);
  assert.equal(activity.lastProgressAt, "2026-10-12T23:59:00.000Z");
});

test("expired running lease is reported as waiting for continuation, never as active scanning", () => {
  const activity = radarRunActivity(run({ leaseUntil: "2026-10-12T23:58:00.000Z" }) as never, now);
  assert.equal(activity.status, "Oczekiwanie na kontynuację");
  assert.equal(activity.hasActiveLease, false);
  assert.equal(activity.currentSource, "domiporta");
});

test("OLX status distinguishes queued, leased worker, expired worker and terminal failure", () => {
  const base = run({
    sourceStatuses: { olx: "running", domiporta: "completed" },
    checkpoint: { sourceQueue: ["domiporta", "olx"], currentSourceIndex: 2 },
  });
  assert.equal(radarRunActivity({ ...base, olxJobStatus: "queued" } as never, now).status, "Oczekiwanie na worker OLX");
  assert.equal(radarRunActivity({ ...base, olxJobStatus: "running", olxJobLeaseUntil: "2026-10-13T00:02:00.000Z" } as never, now).status, "Worker OLX pobiera oferty");
  assert.equal(radarRunActivity({ ...base, olxJobStatus: "running", olxJobLeaseUntil: "2026-10-12T23:59:00.000Z" } as never, now).status, "Oczekiwanie na kontynuację OLX");
  assert.equal(radarRunActivity({ ...base, olxJobStatus: "failed" } as never, now).status, "Błąd terminalny workera OLX");
});

test("terminal partial, completed, failed and stopped runs keep distinct labels", () => {
  const base = run({ leaseUntil: null });
  assert.equal(radarRunActivity({ ...base, status: "partial" } as never, now).status, "Częściowe pokrycie");
  assert.equal(radarRunActivity({ ...base, status: "completed" } as never, now).status, "Zakończono");
  assert.equal(radarRunActivity({ ...base, status: "failed" } as never, now).status, "Błąd terminalny");
  assert.equal(radarRunActivity({ ...base, status: "partial", errorMessage: "RADAR_STOPPED_BY_OPERATOR" } as never, now).status, "Zatrzymano");
  assert.equal(radarRunActivity({ ...base, status: "running", leaseUntil: "2026-10-13T00:01:00.000Z", stopRequestedAt: "2026-10-12T23:59:00.000Z" } as never, now).status, "Zatrzymywanie");
});
