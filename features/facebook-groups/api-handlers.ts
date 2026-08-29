import type { AddWatchedFacebookGroupResult, WatchedFacebookGroup } from "./types";

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

function failure(error: unknown, fallbackStatus = 500) {
  const message = error instanceof Error ? error.message : "Operacja grupy nie powiodła się.";
  return Response.json({ error: message }, { status: fallbackStatus });
}
