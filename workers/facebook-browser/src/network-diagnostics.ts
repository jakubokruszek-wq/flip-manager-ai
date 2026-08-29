import type { Page, Response } from "playwright";
import { logFacebookWorker } from "./logger.ts";

export type FacebookNetworkDiagnostics = {
  responses: number;
  relevantResponses: number;
  postIds: Set<string>;
  mediaIds: Set<string>;
  exactRelations: number;
};


const idPattern = /\b\d{10,20}\b/g;

function safePath(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function extractIds(body: string, keyPattern: RegExp): Set<string> {
  const values = new Set<string>();
  for (const match of body.matchAll(keyPattern)) {
    for (const id of (match[1] ?? "").match(idPattern) ?? []) values.add(id);
  }
  return values;
}

function looksRelevant(response: Response, body: string): boolean {
  const type = response.request().resourceType();
  if (type !== "xhr" && type !== "fetch" && type !== "document") return false;
  return /graphql|relay|feed|story|post|\/ajax\//i.test(response.url())
    || /graphql|relay|story|post|creation_time|feedback|media_id/i.test(body);
}

/** Attaches only when explicitly enabled; listener is best-effort and never blocks page work. */
export function attachFacebookNetworkDiagnostics(page: Page, enabled: boolean): FacebookNetworkDiagnostics | null {
  if (!enabled) return null;
  const state: FacebookNetworkDiagnostics = { responses: 0, relevantResponses: 0, postIds: new Set(), mediaIds: new Set(), exactRelations: 0 };
  page.on("response", (response) => {
    state.responses += 1;
    void (async () => {
      try {
        const contentType = response.headers()["content-type"] ?? "";
        const body = /json|text|javascript/i.test(contentType) ? (await response.text()).slice(0, 1_000_000) : "";
        if (!looksRelevant(response, body)) return;
        state.relevantResponses += 1;
        const postIds = extractIds(body, /(?:post[_-]?id|story[_-]?id|story_fbid|target_id)[^\d]{0,40}([\d]{10,20})/gi);
        const mediaIds = extractIds(body, /(?:media[_-]?id|photo[_-]?id|image[_-]?id)[^\d]{0,40}([\d]{10,20})/gi);
        postIds.forEach((id) => state.postIds.add(id));
        mediaIds.forEach((id) => state.mediaIds.add(id));
        const relations = [...body.matchAll(/(?:post[_-]?id|story[_-]?id)[^\d]{0,40}(\d{10,20})[\s\S]{0,500}?(?:media[_-]?id|photo[_-]?id)[^\d]{0,40}(\d{10,20})/gi)];
        state.exactRelations += relations.length;
        logFacebookWorker("FACEBOOK_NETWORK_RESPONSE_DIAGNOSTIC", {
          url: safePath(response.url()), method: response.request().method(), resourceType: response.request().resourceType(),
          contentType: contentType.split(";", 1)[0], status: response.status(), responseSize: body.length,
          feedLike: /graphql|relay|feed|story|post|creation_time/i.test(body), candidatePostIds: postIds.size,
          candidateMediaIds: mediaIds.size, exactPostMediaRelations: relations.length,
        });
      } catch {
        // Diagnostics are strictly best-effort and must never affect processing.
      }
    })();
  });
  return state;
}

export function networkDiagnosticsSummary(state: FacebookNetworkDiagnostics | null): Record<string, unknown> {
  return state ? { responses: state.responses, relevantResponses: state.relevantResponses, postIds: [...state.postIds], mediaIds: [...state.mediaIds], exactRelations: state.exactRelations } : {};
}
