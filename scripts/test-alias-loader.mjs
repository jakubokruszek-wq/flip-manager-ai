// Bootstrap for the test-only ESM hooks. Next.js resolves project aliases,
// extensionless TypeScript imports, and framework entry points in production;
// plain `node --test` needs the equivalent resolver registered explicitly.
//
// Usage: node --import ./scripts/test-alias-loader.mjs --experimental-strip-types --experimental-test-module-mocks --test <files>

import { register } from "node:module";

register("./test-alias-hooks.mjs", import.meta.url);
