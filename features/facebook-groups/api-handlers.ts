import type { AddWatchedFacebookGroupResult, WatchedFacebookGroup } from "./types";
import type { DiscoveredFacebookGroupCandidate, FacebookGroupImportPreviewItem, HistoricalFacebookSourceMapping } from "./discovery";
import type { FacebookGroupImportOutcome, FacebookGroupImportSelection } from "./server";

type Dependencies = {
  list: () => Promise<WatchedFacebookGroup[]>;
  add: (value: unknown) => Promise<AddWatchedFacebookGroupResult>;
  update: (id: string, value: unknown) => Promise<WatchedFacebookGroup>;
  remove: (id: string) => Promise<WatchedFacebookGroup>;
};

const MAX_DISCOVERY_BODY_BYTES = 256_000;

export function createFacebookGroupsApi(deps: Dependencies) {
  return {
    async get() {
      try { return Response.json({ groups: await deps.list() }); }
      catch (error) { return failure(error); }
    },
    async post(request: Request) {
      try {
        const result = await deps.add(await request.json());
        if (result.success) return Response.json(result, { status: 201 });
        return Response.json(result, { status: result.duplicate ? 409 : 400 });
      } catch (error) { return failure(error); }
    },
    async patch(id: string, request: Request) {
      try { return Response.json({ group: await deps.update(id, await request.json()) }); }
      catch (error) { return failure(error, 400); }
    },
    async delete(id: string) {
      try { return Response.json({ group: await deps.remove(id) }); }
      catch (error) { return failure(error, 400); }
    },
  };
}

/**
 * "Wykryj grupy nieruchomościowe" handoff endpoint. The caller is the
 * browser extension, not a logged-in app session (this app runs without a
 * login boundary at all) -- so, exactly like every other extension-to-
 * server write (see app/api/collector/facebook/*), it must be authenticated
 * with the same signed-device scheme, never left open. Never returns any
 * discovered data itself: only an opaque, short-lived session token the
 * extension hands off to the Manager tab (as a URL fragment, never a query
 * parameter or server log). No unauthenticated "last global preview" GET
 * exists anymore -- every read of a preview requires that exact token.
 */
export function createFacebookGroupDiscoveryApi(deps: {
  discover: (candidates: DiscoveredFacebookGroupCandidate[], deviceId: string | null) => Promise<{ token: string; expiresAt: string }>;
  authenticate: (request: Request, body: string) => Promise<{ deviceId: string | null }>;
}) {
  return {
    async post(request: Request) {
      try {
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > MAX_DISCOVERY_BODY_BYTES) throw new Error("Zbyt duży payload wykrywania grup.");
        const { deviceId } = await deps.authenticate(request, rawBody);
        const candidates = parseCandidates(JSON.parse(rawBody));
        const session = await deps.discover(candidates, deviceId);
        return Response.json(session, { headers: { "Cache-Control": "no-store" } });
      } catch (error) { return failure(error, 400); }
    },
  };
}

/**
 * Retrieves a discovery preview by its opaque token, sent in the request
 * body (never a query string) so it is never captured in server access
 * logs or a Referer header the way a query parameter would be. A wrong,
 * expired, or nonexistent token returns 404 with no distinguishing detail
 * -- never a 401 that would confirm a token's existence -- and the response
 * is always Cache-Control: no-store so no shared cache can ever serve one
 * session's preview to a different request.
 */
export function createFacebookGroupDiscoveryPreviewApi(deps: { preview: (token: string) => Promise<{ preview: FacebookGroupImportPreviewItem[]; expiresAt: string; consumedAt: string | null } | null> }) {
  return {
    async post(request: Request) {
      try {
        const body = await request.json();
        const token = parseToken(body);
        const result = await deps.preview(token);
        if (!result) return Response.json({ error: "Nieprawidłowy lub wygasły token wykrywania grup." }, { status: 404, headers: { "Cache-Control": "no-store" } });
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch (error) { return failure(error, 400); }
    },
  };
}

export function createFacebookGroupImportApi(deps: { importSelected: (token: string, selections: FacebookGroupImportSelection[]) => Promise<FacebookGroupImportOutcome[] | null> }) {
  return {
    async post(request: Request) {
      try {
        const body = await request.json();
        const token = parseToken(body);
        const selections = parseSelections(body);
        const outcomes = await deps.importSelected(token, selections);
        if (!outcomes) return Response.json({ error: "Nieprawidłowy lub wygasły token wykrywania grup." }, { status: 404, headers: { "Cache-Control": "no-store" } });
        return Response.json({ outcomes }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) { return failure(error, 400); }
    },
  };
}

function parseToken(value: unknown): string {
  const token = value && typeof value === "object" ? (value as Record<string, unknown>).token : null;
  if (typeof token !== "string" || !token.trim() || token.length > 200) throw new Error("Podaj token wykrywania grup.");
  return token;
}

export function createFacebookGroupHistoricalMappingApi(deps: { mapping: () => Promise<HistoricalFacebookSourceMapping[]> }) {
  return {
    async get() {
      try { return Response.json({ mapping: await deps.mapping() }); }
      catch (error) { return failure(error); }
    },
  };
}

function parseCandidates(value: unknown): DiscoveredFacebookGroupCandidate[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).candidates)) throw new Error("Podaj listę wykrytych grup.");
  const rawCandidates = (value as { candidates: unknown[] }).candidates;
  if (rawCandidates.length > 200) throw new Error("Zbyt wiele wykrytych grup w jednej partii.");
  return rawCandidates.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Nieprawidłowy wpis wykrytej grupy.");
    const row = item as Record<string, unknown>;
    if (typeof row.url !== "string" || !row.url.trim() || row.url.trim().length > 2_048) throw new Error("Każda wykryta grupa musi mieć poprawnie ograniczony adres URL.");
    return {
      url: row.url.trim(),
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 200) : null,
      discoveredAt: typeof row.discoveredAt === "string" ? row.discoveredAt : new Date().toISOString(),
      skipReason: typeof row.skipReason === "string" && row.skipReason.trim() ? row.skipReason.trim().slice(0, 200) : null,
    };
  });
}

function parseSelections(value: unknown): FacebookGroupImportSelection[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).selections)) throw new Error("Podaj listę grup do zaimportowania.");
  const rawSelections = (value as { selections: unknown[] }).selections;
  if (rawSelections.length === 0) throw new Error("Wybierz co najmniej jedną grupę do zaimportowania.");
  if (rawSelections.length > 50) throw new Error("Zbyt wiele grup do zaimportowania jednocześnie.");
  return rawSelections.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Nieprawidłowy wybór grupy.");
    const row = item as Record<string, unknown>;
    if (typeof row.url !== "string" || !row.url.trim()) throw new Error("Każdy wybór musi mieć adres URL.");
    if (typeof row.name !== "string" || !row.name.trim()) throw new Error("Nazwa grupy jest wymagana dla każdego wyboru.");
    return {
      url: row.url,
      name: row.name.trim(),
      city: typeof row.city === "string" && row.city.trim() ? row.city.trim() : undefined,
      priority: row.priority === "high" ? "high" as const : undefined,
    };
  });
}

function failure(error: unknown, fallbackStatus = 500) {
  const message = error instanceof Error ? error.message : "Operacja grupy nie powiodła się.";
  const status = error instanceof Error && "status" in error && typeof (error as { status: unknown }).status === "number" ? (error as { status: number }).status : fallbackStatus;
  return Response.json({ error: message }, { status });
}
