import type { AddWatchedFacebookGroupResult, WatchedFacebookGroup } from "./types";

type Dependencies = {
  requireUser: (request?: Request) => Promise<void>;
  list: () => Promise<WatchedFacebookGroup[]>;
  add: (value: unknown) => Promise<AddWatchedFacebookGroupResult>;
  update: (id: string, value: unknown) => Promise<WatchedFacebookGroup>;
  remove: (id: string) => Promise<WatchedFacebookGroup>;
};

export function createFacebookGroupsApi(deps: Dependencies) {
  return {
    async get(request: Request) {
      try { await deps.requireUser(request); return Response.json({ groups: await deps.list() }); }
      catch (error) { return failure(error); }
    },
    async post(request: Request) {
      try {
        await deps.requireUser(request);
        const result = await deps.add(await request.json());
        if (result.success) return Response.json(result, { status: 201 });
        return Response.json(result, { status: result.duplicate ? 409 : 400 });
      } catch (error) { return failure(error); }
    },
    async patch(id: string, request: Request) {
      try { await deps.requireUser(request); return Response.json({ group: await deps.update(id, await request.json()) }); }
      catch (error) { return failure(error, 400); }
    },
    async delete(id: string, request: Request) {
      try { await deps.requireUser(request); return Response.json({ group: await deps.remove(id) }); }
      catch (error) { return failure(error, 400); }
    },
  };
}

function failure(error: unknown, fallbackStatus = 500) {
  const message = error instanceof Error ? error.message : "Operacja grupy nie powiodła się.";
  const status = message === "UNAUTHORIZED" ? 401 : fallbackStatus;
  const headers = status === 401 && error && typeof error === "object" && "diagnostics" in error
    ? authDiagnosticHeaders((error as { diagnostics: Record<string, boolean | string> }).diagnostics)
    : undefined;
  return Response.json({ error: message }, { status, headers });
}

function authDiagnosticHeaders(diagnostics: Record<string, boolean | string>): Headers {
  const headers = new Headers();
  const names: Record<string, string> = {
    cookieAuthAttempted: "X-Debug-Auth-Cookie-Attempted", cookieGetUserSuccess: "X-Debug-Auth-Cookie-User",
    authorizationPresent: "X-Debug-Auth-Authorization-Present", bearerParseSuccess: "X-Debug-Auth-Bearer-Parsed",
    bearerGetUserAttempted: "X-Debug-Auth-Bearer-Attempted", bearerGetUserSuccess: "X-Debug-Auth-Bearer-User",
    userPresent: "X-Debug-Auth-User-Present", authSource: "X-Debug-Auth-Source",
  };
  for (const [key, header] of Object.entries(names)) headers.set(header, String(diagnostics[key]));
  const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co/i)?.[1];
  if (ref) headers.set("X-Debug-Supabase-Project-Ref", ref);
  return headers;
}
