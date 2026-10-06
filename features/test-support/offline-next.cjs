/* eslint-disable @typescript-eslint/no-require-imports */
// Preload for isolated builds/browser servers. Never load project dotenv files.
// Use: NODE_OPTIONS="--require ./features/test-support/offline-next.cjs"
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const envPath = require.resolve("@next/env");
const nextEnv = require(envPath);
require.cache[envPath].exports = {
  ...nextEnv,
  loadEnvConfig: () => ({ combinedEnv: process.env, parsedEnv: {}, loadedEnvFiles: [] }),
};
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  if (typeof file === "string" && /(?:^|[\\/])\.env(?:\.[\w-]+)*$/.test(file)) throw new Error("OFFLINE_TEST_DOTENV_READ_FORBIDDEN");
  if (file === "/offline-geist.woff2") file = path.join(path.dirname(require.resolve("next/package.json")), "dist/next-devtools/server/font/geist-latin.woff2");
  return readFileSync.call(this, file, ...args);
};
// Use Next's supported font fixture mechanism with its installed local font.
// Webpack's JS loader observes the isolation hooks in every build worker.
process.env.NEXT_FONT_GOOGLE_MOCKED_RESPONSES = path.join(__dirname, "offline-google-fonts.cjs");
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, ...rest) {
  if (Array.isArray(args) && args.some((arg) => /next[\\/]dist[\\/]bin[\\/]next$/.test(arg)) && args.includes("build") && !args.includes("--webpack")) args = [...args, "--webpack"];
  return spawn.call(this, command, args, ...rest);
};
if (process.env.NEXT_PUBLIC_SUPABASE_URL && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname)) throw new Error("OFFLINE_TEST_REQUIRES_LOOPBACK_SUPABASE");
if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
  // Known, unusable-outside-the-mock fixtures that satisfy the existing key
  // shape validation. Never inherit real admin credentials into this harness.
  process.env.SUPABASE_SECRET_KEY = "sb_secret_offline_browser_fixture_000000000000000000000000";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "offline-build-service-key";
}
const fetch = globalThis.fetch;
globalThis.fetch = function (input, ...args) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("OFFLINE_TEST_EXTERNAL_FETCH_FORBIDDEN");
  return fetch.call(this, input, ...args);
};
