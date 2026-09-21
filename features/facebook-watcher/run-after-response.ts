import { after } from "next/server";

/**
 * Runs `task` so it is guaranteed to complete even after the current route
 * handler's response has been sent, instead of a bare fire-and-forget promise
 * whose serverless invocation can be frozen before it ever settles. Falls
 * back to plain fire-and-forget outside a request scope (e.g. a script or
 * test importing this module directly), where after() throws synchronously.
 */
export function runAfterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}
