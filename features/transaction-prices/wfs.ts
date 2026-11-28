import { parseRcnWfs } from "./model.ts";
import type { RcnRawRow } from "./types.ts";

export const RCN_ENDPOINT = "https://mapa.lodz.pl/OGC/RCN";
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
const MAX_PAGE_BYTES = 512_000;
const TIMEOUT_MS = 12_000;
const CACHE_SECONDS = 6 * 60 * 60;
const FIELDS = ["LOK_ID_LOKALU", "TRAN_LOKALNY_ID_IIP", "TRAN_WERSJA_ID", "TRAN_RODZAJ_TRANS", "TRAN_RODZAJ_RYNKU", "DOK_DATA", "NIER_UDZIAL", "NIER_OPIS", "LOK_FUNKCJA", "LOK_POW_UZYT", "LOK_CENA_BRUTTO", "LOK_INFO", "LOK_ADRES"];

type Fetcher = (input: string | URL, init?: RequestInit & { next?: { revalidate: number } }) => Promise<Response>;
export type RcnStreetData = { rows: RcnRawRow[]; fetchedAt: string; truncated: boolean };

export function validQueryStreet(street: string): boolean {
  return street.length >= 2 && street.length <= 100 && /\p{L}/u.test(street) && !/[\p{Cc}<>]/u.test(street);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function rcnStreetUrl(street: string, startIndex = 0): URL {
  if (!validQueryStreet(street) || ![0, PAGE_SIZE].includes(startIndex)) throw new Error("RCN_INVALID_QUERY");
  // Escape both XML and FES wildcard syntax. A listing cannot broaden the query.
  const literal = escapeXml(street.replace(/[!*?]/g, (character) => `!${character}`));
  const filter = `<fes:Filter xmlns:fes="http://www.opengis.net/fes/2.0"><fes:PropertyIsLike wildCard="*" singleChar="?" escapeChar="!" matchCase="false"><fes:ValueReference>LOK_ADRES</fes:ValueReference><fes:Literal>*${literal}*</fes:Literal></fes:PropertyIsLike></fes:Filter>`;
  const url = new URL(RCN_ENDPOINT);
  for (const [key, value] of Object.entries({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "ms:lokale", count: String(PAGE_SIZE), startIndex: String(startIndex), sortBy: "DOK_DATA D", propertyName: FIELDS.join(","), filter })) url.searchParams.set(key, value);
  return url;
}

function allowedUrl(url: URL): boolean {
  return url.protocol === "https:" && !url.username && !url.password && !url.port && (
    url.hostname === "mapa.lodz.pl" && url.pathname === "/OGC/RCN" ||
    url.hostname === "igeodeta.log.lodz.pl" && url.pathname === "/cgi-bin/lodz-rcn"
  );
}

async function readXml(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_PAGE_BYTES) { await response.body?.cancel(); throw new Error("RCN_RESPONSE_TOO_LARGE"); }
  if (!response.body) throw new Error("RCN_EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_PAGE_BYTES) { await reader.cancel(); throw new Error("RCN_RESPONSE_TOO_LARGE"); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Fixed municipal source; no supplied pagination URLs or credentials are followed. */
export async function fetchRcnStreet(street: string, options: { fetcher?: Fetcher; now?: () => Date } = {}): Promise<RcnStreetData> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const rows: RcnRawRow[] = [];
  const timestamps: string[] = [];
  let truncated = false;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      let url = rcnStreetUrl(street, page * PAGE_SIZE);
      let response: Response | null = null;
      for (let redirect = 0; redirect <= 1; redirect++) {
        if (!allowedUrl(url)) throw new Error("RCN_SOURCE_REJECTED");
        response = await fetcher(url, { redirect: "manual", signal: controller.signal, next: { revalidate: CACHE_SECONDS }, headers: { Accept: "application/gml+xml,text/xml" } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (redirect === 1 || !location) throw new Error("RCN_REDIRECT_REJECTED");
        url = new URL(location, url);
      }
      if (!response?.ok) throw new Error("RCN_SOURCE_UNAVAILABLE");
      const parsed = parseRcnWfs(await readXml(response));
      const date = response.headers.get("date");
      const stamp = date ? new Date(date) : now();
      const safeStamp = Number.isFinite(stamp.getTime()) && stamp.getTime() <= now().getTime() + 300_000 ? stamp.toISOString() : now().toISOString();
      timestamps.push(safeStamp);
      rows.push(...parsed.rows);
      truncated = parsed.hasMore || parsed.returned === PAGE_SIZE;
      if (!truncated || parsed.returned === 0) break;
    }
    return { rows, fetchedAt: timestamps.sort()[0] ?? now().toISOString(), truncated };
  } finally { clearTimeout(timeout); }
}
