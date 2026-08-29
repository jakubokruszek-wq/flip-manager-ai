import { ControlledFacebookFailure } from "./errors.ts";

export const FACEBOOK_GROUP_DEADLINE_MS = 5 * 60_000;

export async function runWithFacebookGroupDeadline<T>(operation: () => Promise<T>, shutdownSignal: AbortSignal, deadlineMs = FACEBOOK_GROUP_DEADLINE_MS): Promise<T> {
  if (shutdownSignal.aborted) throw new ControlledFacebookFailure("FACEBOOK_GROUP_UNAVAILABLE", "FACEBOOK_WORKER_SHUTDOWN");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ControlledFacebookFailure("FACEBOOK_GROUP_UNAVAILABLE", `FACEBOOK_GROUP_DEADLINE_EXCEEDED: ${deadlineMs}ms`)), deadlineMs);
  });
  try { return await Promise.race([operation(), deadline]); }
  finally { if (timer) clearTimeout(timer); }
}
