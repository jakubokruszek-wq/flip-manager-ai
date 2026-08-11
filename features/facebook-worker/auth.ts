import "server-only";

import { resolveFacebookNonceStoreResult, verifyFacebookWorkerAuth } from "./protocol";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";

export async function authenticateFacebookWorkerRequest(request: Request): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  const secret = process.env.FACEBOOK_WORKER_SECRET;
  if (!secret || secret.length < 32) return { ok: false, response: Response.json({ error: "FACEBOOK_WORKER_NOT_CONFIGURED" }, { status: 503 }) };
  const body = await request.text();
  if (body.length > 1_000_000) return { ok: false, response: Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 }) };
  const supabase = createFacebookWatcherAdminClient();
  try {
    const result = await verifyFacebookWorkerAuth({
      secret, method: request.method, pathname: new URL(request.url).pathname, body, headers: request.headers,
      useNonce: async (nonce, expiresAt) => {
        await supabase.from("facebook_worker_nonces").delete().lt("expires_at", new Date().toISOString());
        const inserted = await supabase.from("facebook_worker_nonces").insert({ nonce, expires_at: new Date(expiresAt).toISOString() });
        if (inserted.error) console.error("FACEBOOK NONCE STORE ERROR", { code: inserted.error.code, message: inserted.error.message, details: inserted.error.details, hint: inserted.error.hint });
        return resolveFacebookNonceStoreResult(inserted.error);
      },
    });
    if (!result.ok) return { ok: false, response: Response.json({ error: result.code }, { status: 401 }) };
    return { ok: true, body };
  } catch (error) {
    return { ok: false, response: Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_AUTH_FAILED" }, { status: 503 }) };
  }
}
