import { AsyncLocalStorage } from "node:async_hooks";
import type { AndroidBatchContext } from "./jobs.ts";

// Request-local policy: never change process environment or another consumer.
export type AndroidFinderOwnership = AndroidBatchContext & { deviceId: string };
const androidDataOnly = new AsyncLocalStorage<{ ownership?: AndroidFinderOwnership }>();
export function runAndroidDataOnlyImport<T>(task: () => T, ownership?: AndroidFinderOwnership): T { return androidDataOnly.run({ ownership }, task); }
export function androidDataOnlyImportActive(): boolean { return androidDataOnly.getStore() !== undefined; }
export function androidFinderOwnership(): AndroidFinderOwnership | undefined { return androidDataOnly.getStore()?.ownership; }
