export type ApiAuthUser = { id: string };

export type ApiAuthClient = {
  auth: {
    getUser(token?: string): Promise<{
      data: { user: ApiAuthUser | null };
      error: unknown;
    }>;
  };
};

export async function authenticateApiUserWithClient(request: Request, client: ApiAuthClient): Promise<ApiAuthUser | null> {
  const cookieResult = await client.auth.getUser();
  if (!cookieResult.error && cookieResult.data.user) return cookieResult.data.user;

  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  if (!token) return null;

  const bearerResult = await client.auth.getUser(token);
  return bearerResult.error ? null : bearerResult.data.user;
}
