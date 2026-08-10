import "server-only";

import { verifyWorkerAuth } from "@/features/flip-finder/olx-worker-protocol";
import { createOlxWorkerAdminClient } from "@/features/flip-finder/server/olx-worker-admin";

export async function authenticateOlxWorkerRequest(request: Request): Promise<
  | { ok: true; body: string }
  | { ok: false; response: Response }
> {
  const secret = process.env.OLX_WORKER_SECRET;
  if (!secret) return { ok: false, response: Response.json({ error: "OLX_WORKER_NOT_CONFIGURED" }, { status: 503 }) };
  const body = await request.text();
  if (body.length > 4_000_000) return { ok: false, response: Response.json({ error: "PAYLOAD_TOO_LARGE" }, { status: 413 }) };
  const supabase = createOlxWorkerAdminClient();
  const result = await verifyWorkerAuth({
    secret,
    method: request.method,
    pathname: new URL(request.url).pathname,
    body,
    headers: request.headers,
    useNonce: async (nonce, expiresAt) => {
      await supabase.from("olx_worker_nonces").delete().lt("expires_at", new Date().toISOString());
      const inserted = await supabase.from("olx_worker_nonces").insert({ nonce, expires_at: new Date(expiresAt).toISOString() });
      return !inserted.error;
    },
  });
  if (!result.ok) return { ok: false, response: Response.json({ error: result.code }, { status: 401 }) };
  return { ok: true, body };
}
