// TEST-ONLY: registers scripts/test-alias-loader.mjs as a Node module
// customization hook. `--import` alone only guarantees this file runs before
// the test entry point; the hook itself must still be registered explicitly.
import { register } from "node:module";

register("./test-alias-loader.mjs", import.meta.url);
