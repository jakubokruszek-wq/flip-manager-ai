import { downloadApk } from "@/features/android-download/download";
import { androidZip106 } from "@/features/android-download/release";
export const maxDuration = 300;
export const GET = (request: Request) => downloadApk(request, androidZip106);
export const HEAD = GET;
