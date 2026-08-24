import "server-only";

import { createClient } from "@/lib/supabase/server";
import { authenticateApiUserWithClient, authenticateApiUserWithDiagnostics, type ApiAuthDiagnostics, type ApiAuthUser } from "@/lib/supabase/api-auth-core";

export class ApiAuthError extends Error {
  readonly diagnostics: ApiAuthDiagnostics;
  constructor(diagnostics: ApiAuthDiagnostics) { super("UNAUTHORIZED"); this.name = "ApiAuthError"; this.diagnostics = diagnostics; }
}

export async function authenticateApiUser(request: Request): Promise<ApiAuthUser | null> {
  return authenticateApiUserWithClient(request, await createClient());
}

export async function requireAuthenticatedApiUser(request: Request): Promise<ApiAuthUser> {
  const result = await authenticateApiUserWithDiagnostics(request, await createClient());
  if (!result.user) throw new ApiAuthError(result.diagnostics);
  return result.user;
}

export async function authenticateApiUserDiagnostics(request: Request) {
  return authenticateApiUserWithDiagnostics(request, await createClient());
}
