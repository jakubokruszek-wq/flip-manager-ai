/**
 * A deploy reassigns the Durable Object to the new Worker version, but an
 * instance that keeps receiving requests can go on serving the previous code
 * and environment for a while (seen in stage 2: /status polled every 5 s kept
 * reporting OLX_CLOUD_ENABLED from the older, disabled version). The stateless
 * Worker always runs the deployed version, so its version id is the reference.
 */
export type VersionState = { worker: string | null; runner: string | null };

/** True when both ids are known and differ: the runner still runs an older (or newer) deploy. */
export function runnerVersionStale(state: VersionState): boolean {
  return state.worker !== null && state.runner !== null && state.worker !== state.runner;
}

/** /status block: `matches` is null when an id is unavailable (e.g. no version_metadata binding). */
export function versionReport(state: VersionState, runnerReset: boolean): Record<string, unknown> {
  return {
    worker: state.worker,
    runner: state.runner,
    matches: state.worker === null || state.runner === null ? null : state.worker === state.runner,
    runnerReset,
  };
}
