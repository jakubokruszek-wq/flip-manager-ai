import { AsyncLocalStorage } from "node:async_hooks";

// Request-local policy: never change process environment or another consumer.
const androidDataOnly = new AsyncLocalStorage<boolean>();
export function runAndroidDataOnlyImport<T>(task: () => T): T { return androidDataOnly.run(true, task); }
export function androidDataOnlyImportActive(): boolean { return androidDataOnly.getStore() === true; }
