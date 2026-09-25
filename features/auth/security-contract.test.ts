import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("operator authorization verifies getUser and only app_metadata", () => {
  const source = fs.readFileSync(path.join(root, "features/auth/operator.ts"), "utf8");
  assert.match(source, /auth\.getUser\(\)/);
  assert.match(source, /app_metadata\?\.role\s*!==\s*"operator"/);
  assert.doesNotMatch(source, /getSession\(|user_metadata/);
});

test("SSR auth cookies are hardened and no signup UI exists", () => {
  const authServer = fs.readFileSync(path.join(root, "lib/supabase/auth-server.ts"), "utf8");
  const loginPage = fs.readFileSync(path.join(root, "app/login/page.tsx"), "utf8");
  const loginAction = fs.readFileSync(path.join(root, "app/login/actions.ts"), "utf8");
  assert.match(authServer, /httpOnly:\s*true/);
  assert.match(authServer, /sameSite:\s*"lax"/);
  assert.match(authServer, /secure:\s*process\.env\.NODE_ENV\s*===\s*"production"/);
  assert.doesNotMatch(`${loginPage}\n${loginAction}`, /signUp|signup|rejestr/i);
});

test("client modules do not import admin constructors or service-role secrets", () => {
  const clientFiles = ["app", "components", "features", "lib"].flatMap((directory) => walk(path.join(root, directory))).filter((file) => /\.(?:ts|tsx)$/.test(file)).filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return /^\s*["']use client["'];/m.test(source);
  });
  for (const file of clientFiles) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /supabase\/(?:admin)|createAdminClient|createFacebookWatcherAdminClient|SUPABASE_(?:SERVICE_ROLE|SECRET)_KEY/, path.relative(root, file));
  }
});

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", ".next", "node_modules", ".codex-tmp", "artifacts", "logs"].includes(entry.name)) return [];
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}
