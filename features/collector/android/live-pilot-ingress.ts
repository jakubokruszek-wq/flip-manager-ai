import { AndroidJobError, type AndroidJobStore, androidJobContract } from "./jobs.ts";
import { normalizeFacebookCollectorBatch, type FacebookCollectorBatch } from "../facebook-batch.ts";

/** Additive receiver on the existing dedicated test service. Never imported by Next routes. */
export type LivePilotIngress = {
  deviceId: string; signingKey: string; sourceRegistryId: string; facebookGroupId: string;
  sourceUrl: string; expiresAt: number;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function livePilotIngressConfig(env: Readonly<Record<string, string | undefined>>,
  remote: { signingKey: string; expiresAt: number } | null, now = Date.now()): LivePilotIngress | null {
  if (env.FLIP_LIVE_PILOT_ENABLED !== "true") return null;
  // Reuse the dedicated remote process's identity/TLS/production-ref checks.
  if (!remote || env.FLIP_OFFLINE_REMOTE_TEST !== "true" || env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY ||
      env.OPENAI_API_KEY || env.FACEBOOK_ANDROID_QUEUE_ENABLED === "true" || env.FACEBOOK_ANDROID_INTEGRATION_ENABLED === "true" ||
      env.FACEBOOK_ANDROID_ATOMIC_FINDER_ENABLED === "true") throw Error("PILOT_ISOLATED_RECEIVER_REQUIRED");
  const deviceId = env.FLIP_LIVE_PILOT_DEVICE_ID ?? "";
  const sourceRegistryId = env.FLIP_LIVE_PILOT_SOURCE_REGISTRY_ID ?? "";
  const facebookGroupId = env.FLIP_LIVE_PILOT_FACEBOOK_GROUP_ID ?? "";
  const signingKey = env.FLIP_LIVE_PILOT_SIGNING_KEY ?? "";
  const expiresAt = Number(env.FLIP_LIVE_PILOT_EXPIRES_AT);
  if (!UUID.test(deviceId) || deviceId === "00000000-0000-4000-8000-000000000001" || !UUID.test(sourceRegistryId) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(facebookGroupId) || /^offline/i.test(facebookGroupId) ||
      !/^[a-f0-9]{64}$/.test(signingKey) || signingKey === remote.signingKey ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 3600_000 || expiresAt > remote.expiresAt)
    throw Error("PILOT_CONFIG_INVALID");
  return { deviceId, signingKey, sourceRegistryId, facebookGroupId, sourceUrl: `https://www.facebook.com/groups/${facebookGroupId}/`, expiresAt };
}

export function assertPilotBatch(batch: FacebookCollectorBatch, pilot: LivePilotIngress): void {
  if (batch.sourceType !== "GROUP" || batch.sourceId !== pilot.facebookGroupId || batch.sourceUrl !== pilot.sourceUrl ||
      batch.imageMode !== "SOURCE_SCAN_DATA_ONLY" || batch.posts.length > 20 || batch.posts.length === 0 ||
      !batch.posts.some(post => post.identityConfidence === "EXACT")) throw new AndroidJobError(422, "PILOT_BATCH_REJECTED");
}

export function validatePilotCompletion(body: string, pilot: LivePilotIngress): void {
  if (Buffer.byteLength(body) > 512 * 1024) throw new AndroidJobError(413, "PILOT_PAYLOAD_TOO_LARGE");
  let value: { status?: string; dataMode?: string; batch?: unknown };
  try { value = JSON.parse(body); } catch { throw new AndroidJobError(400, "INVALID_PAYLOAD"); }
  if (!value || value.dataMode !== "LIVE") throw new AndroidJobError(422, "PILOT_MODE_REJECTED");
  if (value.status === "completed") {
    try { assertPilotBatch(normalizeFacebookCollectorBatch(value.batch), pilot); }
    catch (error) { if (error instanceof AndroidJobError) throw error; throw new AndroidJobError(422, "PILOT_BATCH_REJECTED"); }
  }
}

/** Restricts claims and every job lookup in addition to the existing SQL grant/lease fence. */
export function livePilotStore(store: AndroidJobStore, pilot: LivePilotIngress): AndroidJobStore {
  function scoped(job: Parameters<typeof androidJobContract>[0]) {
    const source = androidJobContract(job).group;
    if (source.id !== pilot.sourceRegistryId || source.sourceId !== pilot.facebookGroupId || source.type !== "GROUP" || source.url !== pilot.sourceUrl)
      throw new AndroidJobError(403, "PILOT_SOURCE_FORBIDDEN");
    return job;
  }
  return {
    loadCompletedBatch: store.loadCompletedBatch?.bind(store),
    loadJob: async id => { const job = await store.loadJob(id); return job ? scoped(job) : null; },
    rpc: async (name, args) => {
      if (args.p_device_id !== pilot.deviceId) throw new AndroidJobError(403, "PILOT_DEVICE_FORBIDDEN");
      if (name !== "claim_android_facebook_scan_job") {
        const job = typeof args.p_job_id === "string" ? await store.loadJob(args.p_job_id) : null;
        if (!job) throw new AndroidJobError(409, "ANDROID_JOB_LEASE_LOST");
        scoped(job); // Heartbeat is a direct RPC too; it must not renew another group.
        return store.rpc(name, args);
      }
      if (args.p_source_ids !== undefined && (!Array.isArray(args.p_source_ids) || args.p_source_ids.length !== 1 || args.p_source_ids[0] !== pilot.sourceRegistryId))
        throw new AndroidJobError(403, "PILOT_SOURCE_FORBIDDEN");
      const result = await store.rpc(name, { ...args, p_source_ids: [pilot.sourceRegistryId] });
      if (Array.isArray(result.data)) result.data.forEach(scoped);
      return result;
    },
  };
}
