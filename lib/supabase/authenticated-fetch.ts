import { createClient } from "./client.ts";

type AuthenticatedFetchDependencies = {
  getAccessToken: () => Promise<string | null>;
  fetch: typeof globalThis.fetch;
};

const dependencies: AuthenticatedFetchDependencies = {
  async getAccessToken() {
    try {
      const { data: { session } } = await createClient().auth.getSession();
      return session?.access_token ?? null;
    } catch {
      return null;
    }
  },
  fetch: globalThis.fetch,
};

export async function authenticatedApiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  deps: AuthenticatedFetchDependencies = dependencies,
): Promise<Response> {
  const token = await deps.getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return deps.fetch(input, { ...init, credentials: init.credentials ?? "include", headers });
}
