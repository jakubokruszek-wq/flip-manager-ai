// Offline JSON preview only. Never authenticates, calls a service or enqueues jobs.
import { readFileSync } from "node:fs";
import { planAndroidFacebookScans } from "../features/collector/android/planning.ts";
const filename = process.argv[2];
if (!filename) throw new Error("Usage: node scripts/facebook-android-plan-preview.mjs <read-only-export.json>");
const data = JSON.parse(readFileSync(filename, "utf8"));
if (!Array.isArray(data.groups) || !Array.isArray(data.history)) throw new Error("Export must contain groups[] and history[]");
if (data.groups.some(group => group.activeGroupCount > data.groups.length) || data.history.some(row => row.scopeTotal > data.history.length)) throw new Error("Truncated export: retrieve all pages before ranking");
const now = Date.parse(data.snapshotAt);
if (!Number.isFinite(now)) throw new Error("snapshotAt must be an ISO timestamp");
const plan = planAndroidFacebookScans({ sources: data.groups, history: data.history, now, preview: true });
console.log(JSON.stringify({ ...plan, snapshotAt: new Date(now).toISOString(), inputGroups: data.groups.length, historicalObservations: data.history.length, executedScans: 0 }, null, 2));
