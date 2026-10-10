export type RadarOwnListingFacts = {
  area: number | null;
  rooms: number | null;
  floor: number | null;
  locationText: string | null;
  title?: string | null;
  description?: string | null;
};

export type RadarOwnListingConflict = "area" | "rooms" | "floor" | "location";

export type RadarIdentitySnapshot = Pick<RadarOwnListingFacts, "area" | "rooms" | "floor" | "locationText"> & { price?: number | null };

const OTHER_UNIT = /(?:inne|drugie|kolejne|pozosta\w*|s\u0105siednie|przyk\u0142adowe)\s+(?:mieszkan\w*|lokal\w*)|(?:ofert\w*|wyb\w*r)\s+(?:innych\s+)?lokal\w*/iu;
const PLANNED_LAYOUT = /(?:planowan\w*\s+uk\u0142ad|mo\u017cliwo\w*\s+(?:wydzielenia|przerobienia)|mo\u017cna\s+(?:wydzieli\u0107|przerobi\u0107)|do\s+adaptacji)/iu;

/**
 * Compares only explicit statements about this offer's dwelling with the
 * structured detail facts. It deliberately ignores unsupported number
 * matching, accessory surfaces, planned layouts, and text about other units.
 */
export function findRadarOwnListingConflicts(facts: RadarOwnListingFacts): RadarOwnListingConflict[] {
  const body = `${facts.title ?? ""}. ${facts.description ?? ""}`;
  const sentences = splitSentences(body).filter((sentence) => !OTHER_UNIT.test(sentence));
  const conflicts = new Set<RadarOwnListingConflict>();

  if (facts.area !== null) {
    for (const sentence of sentences) {
      for (const statedArea of ownAreaClaims(sentence)) {
  if (Math.abs(statedArea - facts.area) > Math.max(1, facts.area * 0.01)) conflicts.add("area");
      }
    }
  }

  if (facts.rooms !== null) {
    for (const sentence of sentences) {
      if (PLANNED_LAYOUT.test(sentence)) continue;
      const statedRooms = ownRoomClaims(sentence);
      if (statedRooms.some((rooms) => rooms !== facts.rooms)) conflicts.add("rooms");
    }
  }

  if (facts.floor !== null) {
    for (const sentence of sentences) {
      const statedFloor = ownFloorClaim(sentence);
      if (statedFloor !== null && statedFloor !== facts.floor) conflicts.add("floor");
    }
  }

  const detailArea = microdistrict(facts.locationText ?? "");
  if (detailArea) {
    for (const sentence of sentences) {
      const bodyArea = microdistrict(sentence);
      if (bodyArea && bodyArea !== detailArea) conflicts.add("location");
    }
  }

  return [...conflicts];
}

/** Compares stable dwelling facts between imports; asking-price changes alone
 * are intentionally ignored and never treated as a new property identity. */
export function compareRadarIdentitySnapshots(previous: RadarIdentitySnapshot, incoming: RadarIdentitySnapshot): RadarOwnListingConflict[] {
  const conflicts: RadarOwnListingConflict[] = [];
  if (previous.area !== null && incoming.area !== null && Math.abs(previous.area - incoming.area) > Math.max(1, previous.area * 0.01)) conflicts.push("area");
  if (previous.rooms !== null && incoming.rooms !== null && previous.rooms !== incoming.rooms) conflicts.push("rooms");
  if (previous.floor !== null && incoming.floor !== null && previous.floor !== incoming.floor) conflicts.push("floor");
  const previousArea = microdistrict(previous.locationText ?? "");
  const incomingArea = microdistrict(incoming.locationText ?? "");
  if (previousArea && incomingArea && previousArea !== incomingArea) conflicts.push("location");
  return conflicts;
}

function splitSentences(value: string): string[] {
  return normalize(value).split(/(?<!\d)[.!?;\n]+|[.!?;]+(?!\d)/u).map((part) => part.trim()).filter(Boolean);
}

function ownAreaClaims(sentence: string): number[] {
  const claims: number[] = [];
  const patterns = [
    /\b(?:mieszkan\w*|lokal\w*)\b[^.!?]{0,55}?\b(?:o\s+powierzchni(?:\s+u\u017cytkowej)?|powierzchnia\s+u\u017cytkowa|metra\u017c)\s*(?:wynosz\u0105c\w*\s+)?(?:ok\.?\s*)?(\d{1,3}(?:[,.]\d{1,2})?)\s*m(?:2|\u00b2)(?![\p{L}\p{N}])/iu,
    /\b(?:powierzchnia\s+u\u017cytkowa|metra\u017c)\s*(?:wynos\w*|to|:)\s*(\d{1,3}(?:[,.]\d{1,2})?)\s*m(?:2|\u00b2)(?![\p{L}\p{N}])/iu,
    /\bmetra\u017c\s*(?:(?:wynos\w*|to)\s+|:\s*)?(?:ok\.?\s*)?(\d{1,3}(?:[,.]\d{1,2})?)\s*m(?:2|\u00b2)(?![\p{L}\p{N}])/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(sentence);
    if (!match) continue;
    const value = Number(match[1]?.replace(",", "."));
    if (Number.isFinite(value) && value > 0) claims.push(value);
  }
  return claims;
}

function ownRoomClaims(sentence: string): number[] {
  const patterns = [
    /\b(?:mieszkan\w*|lokal\w*)\b[^.!?]{0,45}?\b(\d{1,2})\s*(?:-|\s)?pokoj\w*/iu,
    /\b(?:mieszkan\w*|lokal\w*)\s+(\d{1,2})\s*[- ]pokojow\w*/iu,
  ];
  return patterns.flatMap((pattern) => {
    const match = pattern.exec(sentence);
    return match ? [Number(match[1])] : [];
  });
}

function ownFloorClaim(sentence: string): number | null {
  const match = sentence.match(/\b(?:po\u0142o\u017con\w*\s+)?(?:na\s+)?(?:parterze|poziomie\s+parteru)\b/iu);
  if (match) return 0;
  const numeric = sentence.match(/\b(?:po\u0142o\u017con\w*\s+)?na\s+(\d{1,2})\s*(?:\.|-)?\s*pi\u0119trze\b/iu);
  return numeric ? Number(numeric[1]) : null;
}

function microdistrict(value: string): string | null {
  const normalized = normalize(value);
  const known: Array<[RegExp, string]> = [
    [/\bteofilow(?:ie|a|u)?\b/u, "teofilow"],
    [/\bbaluty[\s-]*doly\b|\bdoly\s*baluckie\b/u, "baluty-doly"],
    [/\bradogoszcz\b/u, "radogoszcz"],
    [/\bzubardz\b/u, "zubardz"],
    [/\bjulianow\b/u, "julianow"],
    [/\bmarysin\b/u, "marysin"],
    [/\blagiewniki\b/u, "lagiewniki"],
  ];
  return known.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").replace(/[\u0142\u0141]/gu, "l").toLocaleLowerCase("pl-PL").replace(/[^\p{L}\p{N},.]+/gu, " ").replace(/\s+/gu, " ").trim();
}
