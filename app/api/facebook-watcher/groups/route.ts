import { addWatchedFacebookGroup, listWatchedFacebookGroups } from "@/features/facebook-groups/server";

export async function GET() { try { return Response.json({ groups: await listWatchedFacebookGroups() }); } catch (error) { return failure(error); } }
export async function POST(request: Request) {
  try {
    const result = await addWatchedFacebookGroup(await request.json());
    if (result.success) return Response.json(result, { status: 201 });
    return Response.json(result, { status: result.duplicate ? 409 : 400 });
  } catch (error) { return failure(error, 500); }
}
function failure(error: unknown, status = 500) { return Response.json({ error: error instanceof Error ? error.message : "Operacja grupy nie powiodła się." }, { status }); }
