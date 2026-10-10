import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("OLX worker starts with the system CA store and keeps TLS verification enabled", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const command = packageJson.scripts?.["olx-worker"] ?? "";

  assert.match(command, /^node\s+--use-system-ca\b/);
  assert.doesNotMatch(command, /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0|--insecure|--no-verify/i);
});
