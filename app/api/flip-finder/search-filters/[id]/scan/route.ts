import { runManualOtodomScan, scanStatus } from "@/features/flip-finder/server/manual-scan";
type Context = { params: Promise<{ id: string }> };
export async function POST(_request: Request, { params }: Context) { try { return Response.json(await runManualOtodomScan((await params).id)); } catch (error) { return Response.json({ message: error instanceof Error ? error.message : "Nie udało się wykonać skanu." }, { status: scanStatus(error) }); } }
