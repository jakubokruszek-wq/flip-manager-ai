import { downloadApk } from "@/features/android-download/download";
import { androidRelease095 } from "@/features/android-download/release";
export const maxDuration = 300;
export const GET = (request: Request) => downloadApk(request, androidRelease095);
export const HEAD = GET;
