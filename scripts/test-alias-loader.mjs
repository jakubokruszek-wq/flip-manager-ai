// TEST-ONLY Node ESM loader hook, for two gaps between "run under plain node
// --test" and "run inside Next.js's own bundler":
//
// 1. Resolves the "@/*" -> "./*" path alias (defined in tsconfig.json) that
//    Node's own resolver has no knowledge of.
// 2. Stubs the "server-only" package (a dev-time guard Next.js's bundler
//    resolves specially, and which is not even an installed dependency in
//    this project's node_modules) as an empty module, matching how it
//    behaves for a plain server-side import in the real app.
//
// Never used by the application itself — Next.js resolves both independently
// in production.
//
// Usage: node --import ./scripts/test-alias-loader.mjs --experimental-strip-types --experimental-test-module-mocks --test <files>

import { pathToFileURL } from "node:url";
import path from "node:path";

const repoRoot = pathToFileURL(path.resolve(import.meta.dirname, "..") + path.sep).href;
const SERVER_ONLY_STUB = "test-alias-loader:server-only-stub";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only" || specifier === "client-only") {
    return { url: SERVER_ONLY_STUB, shortCircuit: true };
  }
  const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), repoRoot).href : specifier;
  // Next.js's bundler auto-appends an extension for any extensionless
  // relative/aliased import; Node's own resolver does not. This codebase's
  // existing tests work around it by writing ".ts" everywhere, but
  // application source files (reached transitively from server.ts) rely on
  // the bundler's own extension resolution, so mirror that here too.
  try {
    return await nextResolve(target, context);
  } catch (error) {
    if (error?.code === "ERR_UNSUPPORTED_DIR_IMPORT") {
      try {
        return await nextResolve(`${target.replace(/\/$/, "")}/index.ts`, context);
      } catch (indexError) {
        // The application has a few Next.js route imports such as
        // "@/features/facebook-watcher/server" where `server` is a sibling
        // `.ts` module rather than a directory with an index file.
        if (indexError?.code !== "ERR_MODULE_NOT_FOUND") throw indexError;
        return nextResolve(`${target.replace(/\/$/, "")}.ts`, context);
      }
    }
    if (error?.code !== "ERR_MODULE_NOT_FOUND" || /\.[a-z0-9]+$/i.test(target)) throw error;
    return nextResolve(`${target}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (url === SERVER_ONLY_STUB) {
    return { format: "module", source: "export {};", shortCircuit: true };
  }
  return nextLoad(url, context);
}
