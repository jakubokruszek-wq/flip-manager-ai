import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { classifyMutationRoute } from "./route-classification.ts";

const root = path.resolve(import.meta.dirname, "../..");
const apiRoot = path.join(root, "app/api");
const methods = ["POST", "PATCH", "PUT", "DELETE"] as const;

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function exported(source: string, method: string): boolean {
  return new RegExp(`export\\s+(?:(?:async\\s+)?function|const)\\s+${method}\\b`).test(source)
    || new RegExp(`export\\s*\\{[^}]*\\b${method}\\b`).test(source);
}

const mutationRoutes = walk(apiRoot).filter((file) => file.endsWith(`${path.sep}route.ts`)).flatMap((file) => {
  const source = fs.readFileSync(file, "utf8");
  const relativeDirectory = path.relative(apiRoot, path.dirname(file)).replaceAll("\\", "/");
  const pathname = `/api/${relativeDirectory.replace(/\[[^\]]+\]/g, "fixture-id")}`;
  return methods.filter((method) => exported(source, method)).map((method) => ({ file, source, pathname, method }));
});

test("every mutation route has an explicit authentication class", () => {
  const unclassified = mutationRoutes.filter((route) => classifyMutationRoute(route.method, route.pathname) === null);
  assert.deepEqual(unclassified.map((route) => `${route.method} ${route.pathname}`), []);
});

test("every human mutation route directly calls the shared operator guard", () => {
  const unguarded = mutationRoutes.filter((route) => classifyMutationRoute(route.method, route.pathname) === "HUMAN_OPERATOR" && !route.source.includes("requireOperator"));
  assert.deepEqual(unguarded.map((route) => `${route.method} ${route.pathname}`), []);
});

test("privileged clients are not constructed before operator authorization", () => {
  for (const route of mutationRoutes.filter((item) => classifyMutationRoute(item.method, item.pathname) === "HUMAN_OPERATOR")) {
    const guard = route.source.indexOf("await requireOperator()");
    for (const constructor of ["createAdminClient()", "createFacebookWatcherAdminClient()"] as const) {
      const privileged = route.source.indexOf(constructor);
      if (privileged >= 0) assert.ok(guard >= 0 && guard < privileged, `${route.pathname} constructs ${constructor} before auth`);
    }
  }
});

test("signed extension, worker, cron and operator-secret routes keep their dedicated boundaries", () => {
  const samples = new Map([
    ["/api/collector/jobs/claim", "SIGNED_EXTENSION"],
    ["/api/facebook-watcher/groups/discover", "SIGNED_EXTENSION"],
    ["/api/facebook-worker/claim", "SIGNED_WORKER"],
    ["/api/olx-worker/claim", "SIGNED_WORKER"],
    ["/api/jobs/facebook-watch", "CRON_SECRET"],
    ["/api/facebook-watcher/orphans", "OPERATOR_SECRET"],
  ]);
  for (const [pathname, expected] of samples) assert.equal(classifyMutationRoute("POST", pathname), expected);

  assert.match(fs.readFileSync(path.join(root, "features/collector/signed-device-auth.ts"), "utf8"), /verifyCollectorAuth|signingKey/i);
  assert.match(fs.readFileSync(path.join(root, "features/facebook-worker/auth.ts"), "utf8"), /signature|secret/i);
  assert.match(fs.readFileSync(path.join(root, "features/flip-finder/server/olx-worker-auth.ts"), "utf8"), /signature|secret/i);
  assert.match(fs.readFileSync(path.join(root, "app/api/jobs/facebook-watch/route.ts"), "utf8"), /CRON_SECRET/);
  assert.match(fs.readFileSync(path.join(root, "features/facebook-watcher/server/facebook-orphan-auth.ts"), "utf8"), /FACEBOOK_ORPHAN_REPAIR_SECRET/);
});

test("human authorization no longer relies on forgeable action or origin headers", () => {
  const humanSource = mutationRoutes.filter((route) => classifyMutationRoute(route.method, route.pathname) === "HUMAN_OPERATOR").map((route) => route.source).join("\n");
  assert.doesNotMatch(humanSource, /x-flip-finder-action|x-facebook-watcher-action|sec-fetch-site|headers\.get\(["']origin/i);
});
