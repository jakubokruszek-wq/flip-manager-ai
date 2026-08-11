export const FACEBOOK_FAILURE_CODES = [
  "FACEBOOK_LOGIN_REQUIRED",
  "FACEBOOK_SESSION_EXPIRED",
  "FACEBOOK_CHALLENGE",
  "FACEBOOK_ACCESS_DENIED",
  "FACEBOOK_GROUP_UNAVAILABLE",
] as const;

export type FacebookFailureCode = (typeof FACEBOOK_FAILURE_CODES)[number];
export type FacebookJobStatus = "queued" | "running" | "completed" | "failed";

export type FacebookGroupSnapshot = {
  id: string;
  name: string;
  url: string;
};

export type FacebookPostSnapshot = {
  postId: string | null;
  groupId: string;
  permalink: string | null;
  text: string;
  imageUrls: string[];
  publishedAt: string | null;
};

export type FacebookWorkerJob = {
  id: string;
  runId: string;
  sourceScanId: string;
  filterId: string;
  groups: FacebookGroupSnapshot[];
  leaseToken: string;
  leasedUntil: string;
  attempts: number;
};

export type FacebookCompletion = {
  jobId: string;
  leaseToken: string;
  workerId: string;
  posts: FacebookPostSnapshot[];
  warnings: string[];
  durationMs: number;
};

export type FacebookJobState = {
  status: FacebookJobStatus;
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leasedUntil: number | null;
  heartbeatAt: number | null;
};

export function facebookJobIdempotencyKey(filterId: string, scanRunId: string): string {
  return `${filterId}:facebook:${scanRunId}`;
}

export function claimFacebookJobState(state: FacebookJobState, now: number, leaseMs = 180_000): FacebookJobState {
  const canRecover = state.status === "running" && state.leasedUntil !== null && state.leasedUntil < now;
  if (state.status !== "queued" && !canRecover) throw new Error("JOB_NOT_CLAIMABLE");
  if (state.attempts >= state.maxAttempts) throw new Error("LEASE_EXHAUSTED");
  return { ...state, status: "running", attempts: state.attempts + 1, leaseToken: `lease-${state.attempts + 1}`, leasedUntil: now + leaseMs, heartbeatAt: now };
}

export function heartbeatFacebookJobState(state: FacebookJobState, now: number, leaseMs = 180_000): FacebookJobState {
  if (state.status !== "running" || !state.leaseToken) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  return { ...state, heartbeatAt: now, leasedUntil: now + leaseMs };
}

export function settleFacebookJobState(state: FacebookJobState, status: "completed" | "failed"): FacebookJobState {
  if (state.status !== "running" || !state.leaseToken) throw new Error("FACEBOOK_JOB_LEASE_LOST");
  return { ...state, status, leaseToken: null, leasedUntil: null };
}
