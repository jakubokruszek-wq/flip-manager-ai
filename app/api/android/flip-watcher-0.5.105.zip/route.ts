import { downloadApk } from "@/features/android-download/download";
import { androidZip105 } from "@/features/android-download/release";
export const maxDuration = 300;
export const GET = (request: Request) => downloadApk(request, androidZip105);
export const HEAD = GET;
