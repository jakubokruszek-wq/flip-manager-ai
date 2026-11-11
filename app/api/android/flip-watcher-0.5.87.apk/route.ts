import { androidRelease087 } from "@/features/android-download/release";
import { downloadApk } from "@/features/android-download/download";
export const maxDuration = 300;
export async function GET(request:Request) { return downloadApk(request,androidRelease087); }
export const HEAD = GET;
