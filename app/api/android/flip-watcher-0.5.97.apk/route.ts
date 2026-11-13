import { downloadApk } from "@/features/android-download/download";
import { androidRelease097 } from "@/features/android-download/release";
export const maxDuration = 300;
export const GET = (request: Request) => downloadApk(request, androidRelease097);
export const HEAD = GET;
