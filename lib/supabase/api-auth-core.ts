export type ApiAuthUser = { id: string };
export type ApiAuthDiagnostics = {
  cookieAuthAttempted: boolean;
  cookieGetUserSuccess: boolean;
  authorizationPresent: boolean;
  bearerParseSuccess: boolean;
  bearerGetUserAttempted: boolean;
  bearerGetUserSuccess: boolean;
  userPresent: boolean;
  authSource: "cookie" | "bearer" | "none";
};

export type ApiAuthClient = {
  auth: {
    getUser(token?: string): Promise<{
      data: { user: ApiAuthUser | null };
      error: unknown;
    }>;
  };
};

export async function authenticateApiUserWithClient(request: Request, client: ApiAuthClient): Promise<ApiAuthUser | null> {
  return (await authenticateApiUserWithDiagnostics(request, client)).user;
}

export async function authenticateApiUserWithDiagnostics(request: Request, client: ApiAuthClient): Promise<{ user: ApiAuthUser | null; diagnostics: ApiAuthDiagnostics }> {
  const diagnostics: ApiAuthDiagnostics = {
    cookieAuthAttempted: true, cookieGetUserSuccess: false,
    authorizationPresent: request.headers.has("authorization"), bearerParseSuccess: false,
    bearerGetUserAttempted: false, bearerGetUserSuccess: false, userPresent: false, authSource: "none",
  };
  const cookieResult = await client.auth.getUser();
  diagnostics.cookieGetUserSuccess = !cookieResult.error && Boolean(cookieResult.data.user);
  if (diagnostics.cookieGetUserSuccess && cookieResult.data.user) {
    diagnostics.userPresent = true;
    diagnostics.authSource = "cookie";
    return { user: cookieResult.data.user, diagnostics };
  }
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  diagnostics.bearerParseSuccess = Boolean(token);
  if (!token) return { user: null, diagnostics };
  diagnostics.bearerGetUserAttempted = true;
  const bearerResult = await client.auth.getUser(token);
  diagnostics.bearerGetUserSuccess = !bearerResult.error && Boolean(bearerResult.data.user);
  diagnostics.userPresent = diagnostics.bearerGetUserSuccess;
  diagnostics.authSource = diagnostics.bearerGetUserSuccess ? "bearer" : "none";
  return { user: bearerResult.data.user && !bearerResult.error ? bearerResult.data.user : null, diagnostics };
}
