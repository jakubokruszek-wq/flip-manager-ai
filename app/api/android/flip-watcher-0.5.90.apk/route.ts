import { downloadApk } from "@/features/android-download/download";
import { androidRelease090 } from "@/features/android-download/release";
export const maxDuration = 300;
export const GET = (request: Request) => downloadApk(request, androidRelease090);
export const HEAD = GET;
