import { androidRoute } from "@/features/collector/android/server";

export const runtime = "nodejs";
export function POST(request: Request) { return androidRoute(request, "claim"); }
