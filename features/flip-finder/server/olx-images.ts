const PLACEHOLDER_PATTERN = /(?:^|[\/_-])(placeholder|no[-_]?image|default[-_]?image|icon|logo|sprite|pixel)(?:[-\/_.]|$)/i;

export function extractOlxImages(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const images: string[] = [];

  for (const entry of entries) {
    const image = largestImageUrl(entry);
    if (!image || seen.has(image)) continue;
    seen.add(image);
    images.push(image);
  }

  return images;
}

function largestImageUrl(value: unknown): string | null {
  const candidates = imageCandidates(value);
  const valid = candidates
    .map(normalizeImageUrl)
    .filter((candidate): candidate is string => candidate !== null);
  if (!valid.length) return null;
  return valid.reduce((largest, candidate) => imageSizeScore(candidate) > imageSizeScore(largest) ? candidate : largest);
}

function imageCandidates(value: unknown): string[] {
  if (typeof value === "string") return parseSrcset(value);
  if (!isRecord(value)) return [];

  const candidates = [
    ...parseSrcset(stringValue(value.srcset) ?? stringValue(value.srcSet) ?? ""),
    ...["original", "large", "link", "url", "src", "medium", "small", "thumbnail"]
      .flatMap((key) => {
        const image = stringValue(value[key]);
        return image ? parseSrcset(image) : [];
      }),
  ];
  return candidates;
}

function parseSrcset(value: string): string[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length <= 1) return entries.map((entry) => entry.split(/\s+/, 1)[0] ?? "").filter(Boolean);
  return entries
    .map((entry) => {
      const [url = "", descriptor = ""] = entry.split(/\s+/, 2);
      return { url, score: descriptorScore(descriptor) };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.url)
    .filter(Boolean);
}

function normalizeImageUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || PLACEHOLDER_PATTERN.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function imageSizeScore(value: string): number {
  const url = new URL(value);
  const dimensions = url.href.match(/[;?&](?:s=)?(\d{2,5})x(\d{2,5})(?:[;&]|$)/i);
  if (dimensions) return Number(dimensions[1]) * Number(dimensions[2]);
  const width = numericSearchParam(url, ["w", "width"]);
  const height = numericSearchParam(url, ["h", "height"]);
  return width * (height || 1);
}

function descriptorScore(value: string): number {
  const width = value.match(/^(\d+(?:\.\d+)?)w$/i);
  const density = value.match(/^(\d+(?:\.\d+)?)x$/i);
  return width ? Number(width[1]) : density ? Number(density[1]) * 1_000 : 0;
}

function numericSearchParam(url: URL, names: string[]): number {
  for (const name of names) {
    const value = Number(url.searchParams.get(name));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
