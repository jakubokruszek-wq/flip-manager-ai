import { requireFacebookGroupsUser } from "@/features/facebook-groups/api-auth";
import { removeWatchedFacebookGroup, updateWatchedFacebookGroupDetails } from "@/features/facebook-groups/server";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    await requireFacebookGroupsUser();
    return Response.json({ group: await updateWatchedFacebookGroupDetails((await params).id, await request.json()) });
  } catch (error) { return failure(error, "Aktualizacja grupy nie powiodła się."); }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    await requireFacebookGroupsUser();
    return Response.json({ group: await removeWatchedFacebookGroup((await params).id) });
  } catch (error) { return failure(error, "Usunięcie grupy nie powiodło się."); }
}

function failure(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  return Response.json({ error: message }, { status: message === "UNAUTHORIZED" ? 401 : 400 });
}
