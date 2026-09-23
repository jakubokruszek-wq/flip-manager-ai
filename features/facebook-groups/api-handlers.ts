import type { AddWatchedFacebookGroupResult, WatchedFacebookGroup } from "./types";
import type { DiscoveredFacebookGroupCandidate, FacebookGroupImportPreviewItem, HistoricalFacebookSourceMapping } from "./discovery";
import type { FacebookGroupImportOutcome, FacebookGroupImportSelection } from "./server";

type Dependencies = {
  list: () => Promise<WatchedFacebookGroup[]>;
  add: (value: unknown) => Promise<AddWatchedFacebookGroupResult>;
  update: (id: string, value: unknown) => Promise<WatchedFacebookGroup>;
  remove: (id: string) => Promise<WatchedFacebookGroup>;
};

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
 * "Wykryj grupy nieruchomościowe" preview endpoint. Strictly read-only: it
 * only classifies what the extension reported, never writes a row — the
 * explicit, separate import endpoint below is the only write path, and only
 * for whatever the user has actually selected.
 */
export function createFacebookGroupDiscoveryApi(deps: {
  preview: (candidates: DiscoveredFacebookGroupCandidate[]) => Promise<FacebookGroupImportPreviewItem[]>;
  lastPreview?: () => { preview: FacebookGroupImportPreviewItem[]; generatedAt: string } | null;
  /**
   * The caller of this endpoint is the browser extension, not a logged-in
   * app session (unlike the group CRUD routes above, which this app runs
   * without a login boundary at all) -- so, exactly like every other
   * extension-to-server write (see app/api/collector/facebook/*), it must be
   * authenticated with the same signed-device scheme, never left open.
   */
  authenticate?: (request: Request, body: string) => Promise<void>;
}) {
  return {
    async post(request: Request) {
      try {
        const rawBody = await request.text();
        if (deps.authenticate) await deps.authenticate(request, rawBody);
        const candidates = parseCandidates(JSON.parse(rawBody));
        return Response.json({ preview: await deps.preview(candidates) });
      } catch (error) { return failure(error, 400); }
    },
    async get() {
      try { return Response.json(deps.lastPreview?.() ?? { preview: [], generatedAt: null }); }
      catch (error) { return failure(error); }
    },
  };
}

export function createFacebookGroupImportApi(deps: { importSelected: (selections: FacebookGroupImportSelection[]) => Promise<FacebookGroupImportOutcome[]> }) {
  return {
    async post(request: Request) {
      try {
        const body = await request.json();
        const selections = parseSelections(body);
        return Response.json({ outcomes: await deps.importSelected(selections) });
      } catch (error) { return failure(error, 400); }
    },
  };
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
    if (typeof row.url !== "string" || !row.url.trim()) throw new Error("Każda wykryta grupa musi mieć adres URL.");
    return {
      url: row.url,
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
