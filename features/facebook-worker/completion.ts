import { FACEBOOK_AUTHORITATIVE_POST_TEXT_SOURCES, FACEBOOK_CONFIDENCE_FIELDS, FACEBOOK_IMAGE_RELEVANCE, FACEBOOK_LISTING_INTENTS, type FacebookCompletion, type FacebookFieldConfidence, type FacebookGroupSnapshot, type FacebookImageAssessment, type FacebookPostSnapshot, type FacebookVisionExtraction } from "./types.ts";

const FACEBOOK_HOST = /(^|\.)facebook\.com$/i;
const MAX_POSTS = 20;
const MAX_TEXT = 2_000;
const MAX_IMAGES = 5;

export function assertFacebookGroupUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !FACEBOOK_HOST.test(url.hostname) || !/^\/groups\/[^/]+/i.test(url.pathname)) throw new Error("FACEBOOK_GROUP_URL_NOT_ALLOWED");
  return url;
}

export function assertFacebookPermalink(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !FACEBOOK_HOST.test(url.hostname)) throw new Error("FACEBOOK_POST_URL_NOT_ALLOWED");
  return url.toString();
}

export function parseFacebookGroupSnapshot(value: unknown): FacebookGroupSnapshot[] {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("FACEBOOK_GROUP_REQUIRED");
  const row = requireRow(value[0]);
  return [{ id: requiredString(row.id, "GROUP_ID", 200), name: requiredString(row.name, "GROUP_NAME", 200), url: assertFacebookGroupUrl(requiredString(row.url, "GROUP_URL", 2_000)).toString() }];
}

export function parseFacebookCompletionPayload(value: unknown): FacebookCompletion {
  const row = requireRow(value);
  if (!Array.isArray(row.posts) || row.posts.length > MAX_POSTS) throw new Error("INVALID_FACEBOOK_POSTS");
  return {
    jobId: requiredString(row.jobId, "JOB_ID", 100),
    leaseToken: requiredString(row.leaseToken, "LEASE_TOKEN", 100),
    workerId: requiredString(row.workerId, "WORKER_ID", 100),
    posts: row.posts.map(parsePost),
    warnings: stringArray(row.warnings, 20, 500),
    durationMs: nonnegativeInteger(row.durationMs),
  };
}

function parsePost(value: unknown): FacebookPostSnapshot {
  const row = requireRow(value);
  return {
    postId: nullableString(row.postId, 300),
    groupId: requiredString(row.groupId, "GROUP_ID", 200),
    permalink: row.permalink === null ? null : assertFacebookPermalink(requiredString(row.permalink, "PERMALINK", 2_000)),
    authoritativePostText: nullableString(row.authoritativePostText, MAX_TEXT),
    authoritativePostTextSource: FACEBOOK_AUTHORITATIVE_POST_TEXT_SOURCES.includes(row.authoritativePostTextSource as never) ? row.authoritativePostTextSource as FacebookPostSnapshot["authoritativePostTextSource"] : "NONE",
    text: typeof row.text === "string" ? row.text.slice(0, MAX_TEXT) : "",
    imageUrls: stringArray(row.imageUrls, MAX_IMAGES, 2_000).map(assertHttpsUrl),
    publishedAt: nullableIsoDate(row.publishedAt),
    vision: parseVision(row.vision),
  };
}

function parseVision(value: unknown): FacebookVisionExtraction | null {
  if (value === null || value === undefined) return null;
  const row = requireRow(value);
  if (typeof row.isProperty !== "boolean") throw new Error("INVALID_FACEBOOK_VISION");
  return { isProperty: row.isProperty === true, listingIntent: FACEBOOK_LISTING_INTENTS.includes(row.listingIntent as never) ? row.listingIntent as FacebookVisionExtraction["listingIntent"] : "UNKNOWN", intentConfidence: boundedConfidence(row.intentConfidence), title: nullableString(row.title, 500), description: nullableString(row.description, 2_000), visibleText: nullableString(row.visibleText, 2_000), city: nullableString(row.city, 200), district: nullableString(row.district, 200), neighborhood: nullableString(row.neighborhood, 200), street: nullableString(row.street, 300), price: nullableNumber(row.price), area: nullableNumber(row.area), rooms: nullableNumber(row.rooms), floor: nullableNumber(row.floor), totalFloors: nullableNumber(row.totalFloors), condition: row.condition === "renovation" || row.condition === "ready" ? row.condition : null, sellerType: row.sellerType === "private" || row.sellerType === "agency" ? row.sellerType : null, confidence: boundedConfidence(row.confidence), fieldConfidence: parseFieldConfidence(row.fieldConfidence), imageAssessments: parseImageAssessments(row.imageAssessments) };
}

function parseImageAssessments(value: unknown): FacebookImageAssessment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_IMAGES).flatMap((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null;
    if (!row || !Number.isInteger(row.imageIndex) || !FACEBOOK_IMAGE_RELEVANCE.includes(row.relevance as never)) return [];
    return [{ imageIndex: row.imageIndex as number, relevance: row.relevance as FacebookImageAssessment["relevance"], confidence: boundedConfidence(row.confidence) }];
  });
}

function parseFieldConfidence(value: unknown): FacebookFieldConfidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  return Object.fromEntries(FACEBOOK_CONFIDENCE_FIELDS.map((field) => [field, boundedConfidence(row[field])])) as FacebookFieldConfidence;
}

function assertHttpsUrl(value: string): string { const url = new URL(value); if (url.protocol !== "https:") throw new Error("INVALID_IMAGE_URL"); return url.toString(); }
function requireRow(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD"); return value as Record<string, unknown>; }
function requiredString(value: unknown, field: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`INVALID_${field}`); return value.trim(); }
function nullableString(value: unknown, max: number): string | null { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null; }
function nullableIsoDate(value: unknown): string | null { if (value === null || value === undefined || value === "") return null; if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("INVALID_PUBLISHED_AT"); return new Date(value).toISOString(); }
function nonnegativeInteger(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("INVALID_NUMBER"); return value; }
function nullableNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function boundedConfidence(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
function stringArray(value: unknown, maxItems: number, maxLength: number): string[] { if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length > maxLength)) throw new Error("INVALID_STRING_ARRAY"); return value.map(String); }
