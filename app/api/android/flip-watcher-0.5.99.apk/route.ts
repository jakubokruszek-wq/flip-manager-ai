import { downloadApk } from "@/features/android-download/download";
import { androidRelease099 } from "@/features/android-download/release";
export const maxDuration = 300;
export const GET = (request: Request) => downloadApk(request, androidRelease099);
export const HEAD = GET;
