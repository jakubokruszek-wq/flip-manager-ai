import "server-only";

import type { AuthError, User } from "@supabase/supabase-js";

import { createAuthServerClient } from "@/lib/supabase/auth-server";

export type OperatorIdentity = Readonly<{ id: string; email: string | null }>;

export class OperatorAuthorizationError extends Error {
  constructor(readonly status: 401 | 403, readonly code: "OPERATOR_SESSION_REQUIRED" | "OPERATOR_ROLE_REQUIRED") {
    super(code);
    this.name = "OperatorAuthorizationError";
  }
}

type GetUserResult = { data: { user: User | null }; error: AuthError | null };

export function authorizeOperatorResult(result: GetUserResult): OperatorIdentity {
  const user = result.data.user;
  if (result.error || !user) throw new OperatorAuthorizationError(401, "OPERATOR_SESSION_REQUIRED");
  if (user.app_metadata?.role !== "operator") throw new OperatorAuthorizationError(403, "OPERATOR_ROLE_REQUIRED");
  return Object.freeze({
    id: user.id.slice(0, 128),
    email: typeof user.email === "string" ? user.email.slice(0, 320) : null,
  });
}

export async function requireOperator(): Promise<OperatorIdentity> {
  const supabase = await createAuthServerClient();
  return authorizeOperatorResult(await supabase.auth.getUser());
}

export function operatorAuthorizationResponse(error: unknown): Response {
  if (error instanceof OperatorAuthorizationError) {
    return Response.json({ ok: false, code: error.code }, { status: error.status });
  }
  throw error;
}
