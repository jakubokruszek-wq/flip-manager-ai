import { exactStream } from "./exact-stream";
import { androidRelease, type AndroidRelease } from "./release";
function headers(apk:AndroidRelease) { return new Headers({ "Content-Type": "application/vnd.android.package-archive", "Content-Disposition": `attachment; filename="${apk.filename}"`, "Accept-Ranges": "bytes", ETag: `"sha256-${apk.sha256}"`, "Cache-Control": "public, max-age=86400, immutable", "X-Content-Type-Options": "nosniff" }); }
/** Stream opaque APK bytes; never allocate the full 214 MB in phone JS or function memory. */
export async function downloadApk(request: Request, apk:AndroidRelease=androidRelease): Promise<Response> {
  const etag=`"sha256-${apk.sha256}"`;
  const resultHeaders = headers(apk);
  const range = request.headers.get("range");
  let wanted: string | null = null;
  if (range && (!request.headers.has("if-range") || request.headers.get("if-range") === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${apk.bytes}`, "Cache-Control": "no-store" } });
    const start = match[1] ? Number(match[1]) : Math.max(0, apk.bytes - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(apk.bytes - 1, Number(match[2])) : apk.bytes - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= apk.bytes) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${apk.bytes}`, "Cache-Control": "no-store" } });
    wanted = `bytes=${start}-${end}`;
  }
  if (request.method === "HEAD") { resultHeaders.set("Content-Length", String(apk.bytes)); return new Response(null, { headers: resultHeaders }); }
  try {
    const upstream = await fetch(apk.source, { headers: wanted ? { Range: wanted } : {}, redirect: "follow", cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(285000)]) });
    const length = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");
    const partial = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    const validPartial = upstream.status === 206 && !!wanted && !!partial && wanted === `bytes=${partial[1]}-${partial[2]}` && Number(partial[3]) === apk.bytes && Number(length) === Number(partial[2]) - Number(partial[1]) + 1;
    const validFull = upstream.status === 200 && Number(length) === apk.bytes && !contentRange;
    if (!upstream.body || (!validFull && !validPartial)) { await upstream.body?.cancel(); throw new Error(`APK_UPSTREAM_${upstream.status}`); }
    resultHeaders.set("Content-Length", length!);
    if (validPartial) { resultHeaders.set("Content-Range", contentRange!); resultHeaders.set("Cache-Control", "no-store"); }
    return new Response(exactStream(upstream.body, Number(length)), { status: upstream.status, headers: resultHeaders });
  } catch (error) {
    console.error("android_download_failed", error instanceof Error ? error.message : "unknown");
    return Response.json({ message: "Pobieranie chwilowo niedostępne. Wznów pobieranie za chwilę lub użyj zapasowego linku na stronie Android." }, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } });
  }
}
