import { androidMetadataRoute } from "@/features/collector/android/metadata-server";
export const runtime = "nodejs";
export function POST(request: Request) { return androidMetadataRoute(request, "sources/sync"); }
