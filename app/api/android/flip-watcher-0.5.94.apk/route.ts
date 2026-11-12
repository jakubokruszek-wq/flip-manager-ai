import { downloadApk } from "@/features/android-download/download";
import { androidRelease094 } from "@/features/android-download/release";
export const maxDuration = 300;
export const GET = (request: Request) => downloadApk(request, androidRelease094);
export const HEAD = GET;
