import { addWatchedFacebookGroup, listWatchedFacebookGroups } from "@/features/facebook-groups/server";
import { requireFacebookGroupsUser } from "@/features/facebook-groups/api-auth";

export async function GET() { try { await requireFacebookGroupsUser(); return Response.json({ groups: await listWatchedFacebookGroups() }); } catch (error) { return failure(error); } }
export async function POST(request: Request) {
  try {
    await requireFacebookGroupsUser();
    const result = await addWatchedFacebookGroup(await request.json());
    if (result.success) return Response.json(result, { status: 201 });
    return Response.json(result, { status: result.duplicate ? 409 : 400 });
  } catch (error) { return failure(error, 500); }
}
function failure(error: unknown, status = 500) { const message = error instanceof Error ? error.message : "Operacja grupy nie powiodła się."; return Response.json({ error: message }, { status: message === "UNAUTHORIZED" ? 401 : status }); }
