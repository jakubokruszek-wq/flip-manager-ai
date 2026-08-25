import type { Page } from "playwright";
import type { FacebookAgeCacheHit, FacebookAuthoritativePostTextProvenance, FacebookAuthoritativePostTextSource, FacebookMediaCandidate, FacebookPostSnapshot, FacebookVisionExtraction } from "../../../features/facebook-worker/types.ts";
import { inspectFacebookIntentSignals, type FacebookIntentSignalName } from "../../../features/facebook-watcher/facebook-intent.ts";
import { logFacebookWorker } from "./logger.ts";
import { shouldStopForKnownOldSequence } from "../../../features/facebook-worker/performance.ts";

export const MAX_FACEBOOK_DISCOVERED_POSTS = 50;
export const MAX_FACEBOOK_DISCOVERY_SCROLLS = 20;
export const MAX_FACEBOOK_EMPTY_SCROLLS = 3;
export const MAX_VISION_POSTS_PER_JOB = 15;
export const MAX_FACEBOOK_POSTS_PER_JOB = MAX_FACEBOOK_DISCOVERED_POSTS;
export const FACEBOOK_POST_MAX_AGE_MS = 72 * 60 * 60 * 1_000;

export type DiscoveredFacebookPost = { postId: string; permalink: string };
export type FacebookFeedAgeDiagnostic = { postId: string; candidatesFound: number; selectedSource: string | null; bindingMethod: string | null; machineReadable: boolean; ageHours: number | null; decision: "PROCESS" | "TOO_OLD" | "UNKNOWN"; rejectionReason: "NO_TIMESTAMP" | "COMMENT_CONTEXT" | "SHARED_OR_ATTACHMENT_CONTEXT" | "ADJACENT_POST_AMBIGUITY" | "AMBIGUOUS_TIMESTAMP" | "DATE_PRECISION_CROSSES_72H" | "INVALID_TIMESTAMP" | null };
export type FreshDiscoveredFacebookPost = DiscoveredFacebookPost & { discoveredPublishedAt: string | null; freshnessFailure: FacebookPostFreshnessFailure | null; feedAgeDiagnostic?: FacebookFeedAgeDiagnostic };
export type FacebookPostFreshnessFailure = "FACEBOOK_POST_TOO_OLD" | "FACEBOOK_POST_AGE_UNKNOWN";
export type FacebookPostAgeSource = "FEED" | "POST_PAGE_METADATA" | "POST_PAGE" | "AGE_CACHE";
export type FacebookPostAgeResolution = { post: FreshDiscoveredFacebookPost; source: FacebookPostAgeSource; ageHours: number | null; decision: "PROCESS" | "TOO_OLD" | "UNKNOWN" };
export type FacebookPostAgeFallback = { publishedAt: string | null; source: "POST_PAGE_METADATA" | "POST_PAGE" };
export type FacebookPostTimeDiagnostic = {
  post_id: string;
  final_path: string;
  candidates: Array<{ tag: string; role: string | null; attribute_names: string[]; datetime: string | null; data_utime: string | null; data_timestamp: string | null; aria_label_parseable_as_time: boolean; title_parseable_as_time: boolean; nesting_depth: number | null; inside_main: boolean; inside_comment_region: boolean; distance_to_post_region: number | null; candidate_score: number }>;
  metadata: Array<{ metadata_source: string; timestamp_value: string; linked_to_expected_post_id: boolean }>;
};
export type FacebookDiscoveryStopReason = "OLDER_THAN_72H" | "KNOWN_OLD_SEQUENCE" | "MAX_POSTS" | "MAX_SCROLLS" | "NO_NEW_POSTS" | "END_OF_FEED" | "DEBUG_TARGET";
export type FacebookDiscoveryLoopResult = { posts: FreshDiscoveredFacebookPost[]; scrollCount: number; stopReason: FacebookDiscoveryStopReason };
export type FacebookPostRegion = { screenshotDataUrl: string; imageUrls: string[]; mediaCandidates: FacebookMediaCandidate[]; publishedAt: string | null; authoritativePostText: string; authoritativePostTextSource: FacebookAuthoritativePostTextSource; authoritativePostTextProvenance: FacebookAuthoritativePostTextProvenance; box: { x: number; y: number; width: number; height: number }; candidateCount: number; selectedMediaCount?: number; screenshotWidth: number; screenshotHeight: number; captureMethod: "ELEMENT_SCREENSHOT" | "CLIP_FALLBACK"; compressed: boolean };
export type FacebookPostRegionFailureReason = "POST_ANCHOR_NOT_FOUND" | "NO_ANCESTOR_CANDIDATES" | "ALL_TOO_SMALL" | "ALL_REJECTED_AS_COMMENTS" | "NO_CONTENT_NODES" | "INVALID_BOUNDING_BOX" | "AMBIGUOUS_CANDIDATES" | "UNKNOWN";
export type FacebookPostRegionDiagnosticCounts = {
  dedicatedPageUrlMatches: boolean;
  canonicalAnchorCount: number;
  candidateAncestorCount: number;
  candidatesAfterSizeFilter: number;
  candidatesAfterContentFilter: number;
  candidatesAfterCommentFilter: number;
  candidatesAfterVisibilityFilter: number;
  validBoundingBoxCount: number;
  ambiguousTopCandidates: boolean;
};

export type FacebookPostRegionRankingCandidate = {
  rootIndex: number;
  score: number;
  area: number;
  visible: boolean;
  validBoundingBox: boolean;
  hasContent: boolean;
  containsCommentSection: boolean;
  containsToolbar: boolean;
  containsForm: boolean;
  mediaCount: number;
  textNodeCount: number;
  nestingDepth: number | null;
};

export function rankFacebookPostRegionCandidates<T extends FacebookPostRegionRankingCandidate>(candidates: T[]): { ranked: T[]; cleanPoolUsed: boolean; ambiguous: boolean } {
  const clean = candidates.filter((candidate) => candidate.visible
    && candidate.validBoundingBox
    && candidate.hasContent
    && !candidate.containsCommentSection
    && !candidate.containsToolbar
    && !candidate.containsForm);
  const cleanPoolUsed = clean.length > 0;
  const ranked = [...(cleanPoolUsed ? clean : candidates)].sort((left, right) => {
    if (cleanPoolUsed) {
      return right.mediaCount - left.mediaCount
        || right.textNodeCount - left.textNodeCount
        || right.score - left.score
        || (left.nestingDepth ?? Number.MAX_SAFE_INTEGER) - (right.nestingDepth ?? Number.MAX_SAFE_INTEGER)
        || left.area - right.area;
    }
    return right.score - left.score || left.area - right.area;
  });
  const first = ranked[0];
  const second = ranked[1];
  const ambiguous = Boolean(first && second
    && first.mediaCount === second.mediaCount
    && first.textNodeCount === second.textNodeCount
    && Math.abs(first.score - second.score) < 0.001
    && first.nestingDepth === second.nestingDepth
    && Math.abs(first.area - second.area) < 100);
  return { ranked, cleanPoolUsed, ambiguous };
}

export function determineFacebookPostRegionFailureReason(counts: FacebookPostRegionDiagnosticCounts): FacebookPostRegionFailureReason {
  if (!counts.dedicatedPageUrlMatches) return "POST_ANCHOR_NOT_FOUND";
  if (counts.candidateAncestorCount === 0) return "NO_ANCESTOR_CANDIDATES";
  if (counts.candidatesAfterSizeFilter === 0) return "ALL_TOO_SMALL";
  if (counts.candidatesAfterContentFilter === 0) return "NO_CONTENT_NODES";
  if (counts.candidatesAfterCommentFilter === 0) return "ALL_REJECTED_AS_COMMENTS";
  if (counts.candidatesAfterVisibilityFilter === 0 || counts.validBoundingBoxCount === 0) return "INVALID_BOUNDING_BOX";
  if (counts.ambiguousTopCandidates) return "AMBIGUOUS_CANDIDATES";
  return "UNKNOWN";
}

export async function processDedicatedFacebookPost(post: DiscoveredFacebookPost, groupId: string, dependencies: { open: (permalink: string) => Promise<void>; capture: (postId: string) => Promise<FacebookPostRegion>; analyze: (input: { postId: string; screenshotDataUrl: string; imageUrls: string[] }) => Promise<FacebookVisionExtraction> }): Promise<FacebookPostSnapshot> {
  await dependencies.open(post.permalink);
  const region = await dependencies.capture(post.postId);
  const vision = await dependencies.analyze({ postId: post.postId, screenshotDataUrl: region.screenshotDataUrl, imageUrls: region.imageUrls });
  const discoveredPublishedAt = "discoveredPublishedAt" in post && typeof post.discoveredPublishedAt === "string" ? post.discoveredPublishedAt : null;
  return { postId: post.postId, groupId, permalink: post.permalink, authoritativePostText: region.authoritativePostText, authoritativePostTextSource: region.authoritativePostTextSource, authoritativePostTextProvenance: region.authoritativePostTextProvenance, text: vision.visibleText ?? "", imageUrls: region.imageUrls, mediaCandidates: region.mediaCandidates, publishedAt: region.publishedAt ?? discoveredPublishedAt, vision };
}

export type FacebookMetadataTextCandidateDiagnostic = {
  field_path_category: string;
  text_layer: FacebookPostTextLayer;
  field_name: string;
  text_length: number;
  nesting_depth: number;
  direct_post_field: boolean;
  under_attachment: boolean;
  under_shared: boolean;
  under_media: boolean;
  under_comment: boolean;
  root_story_bound: boolean;
  root_author_message: boolean;
  buy_signals: FacebookIntentSignalName[];
  sell_signals: FacebookIntentSignalName[];
};

export type FacebookPostTextLayer = "OUTER_POST_TEXT" | "SHARED_POST_TEXT" | "ATTACHMENT_TEXT" | "MEDIA_TEXT" | "COMMENT_TEXT" | "IGNORED_TEXT";

export type FacebookMetadataTextResolution = {
  text: string;
  outerText: string;
  sharedText: string;
  attachmentText: string;
  mediaText: string;
  rootStoryIdentified: boolean;
  rootAuthorMessageIdentified: boolean;
  sharedContentDetected: boolean;
  candidates: FacebookMetadataTextCandidateDiagnostic[];
  selectedCandidateIndex: number | null;
  selectedReason: string;
};

export type FacebookAuthoritativeTextSourceResolution = {
  text: string;
  source: FacebookAuthoritativePostTextSource;
  metadataBuySignals: FacebookIntentSignalName[];
  metadataSellSignals: FacebookIntentSignalName[];
  domBuySignals: FacebookIntentSignalName[];
  domSellSignals: FacebookIntentSignalName[];
  conflict: boolean;
  selectedLayer: "ROOT_AUTHOR_MESSAGE" | "SHARED_CONTENT_TEXT" | "AMBIGUOUS_COMPOSITE" | "NONE" | "CONFLICT";
  provenance: FacebookAuthoritativePostTextProvenance;
};

type MetadataTextCandidate = FacebookMetadataTextCandidateDiagnostic & { text: string; priority: number; selectable: boolean };

export function extractFacebookAuthoritativeTextResolutionFromStructuredData(values: unknown[], expectedPostId: string): FacebookMetadataTextResolution {
  const candidates: MetadataTextCandidate[] = [];
  const idKey = /^(?:id|post_id|postid|story_fbid|feedback_target_id)$/i;
  const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const directPostId = (value: Record<string, unknown>) => Object.entries(value).find(([key, item]) => idKey.test(key) && (typeof item === "string" || typeof item === "number"))?.[1];
  const attachmentKey = /attachment/i;
  const mediaKey = /media|photo|video|gallery|thumbnail/i;
  const sharedKey = /attached_story|shared_story|reshared_post|shared_post|quoted|repost|reshare|substory|share/i;
  const commentKey = /comment|repl(?:y|ies)|feedback|reaction/i;
  const authorKey = /^(?:actor|actors|author|authors|owner|composer|creation_actor)$/i;
  const accessibilityKey = /accessibility|alt(?:_text)?|recommend|sidebar|header/i;
  const textualKey = /^(?:message|message_text|text|story|body|title|description|caption|alt|alt_text|accessibility_text)$/i;
  let rootStoryIdentified = false;
  let sharedContentDetected = false;
  const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 2_000);
  const addCandidate = (textValue: string, fieldName: string, path: string[], depth: number, inheritedPath: string[], rootStoryBound: boolean): void => {
    const text = normalizeText(textValue);
    if (text.length < 8) return;
    const lowerPath = [...inheritedPath, ...path].map((item) => item.toLowerCase());
    const relativePath = path.map((item) => item.toLowerCase());
    const underAttachment = lowerPath.some((item) => attachmentKey.test(item));
    const underMedia = lowerPath.some((item) => mediaKey.test(item));
    const underShared = lowerPath.some((item) => sharedKey.test(item));
    const underComment = lowerPath.some((item) => commentKey.test(item));
    const underAccessibility = lowerPath.some((item) => accessibilityKey.test(item));
    const semanticBoundary = relativePath.reduce((last, item, index) => sharedKey.test(item) || attachmentKey.test(item) || mediaKey.test(item) || commentKey.test(item) ? index : last, -1);
    const directPath = relativePath.slice(semanticBoundary + 1).join(".");
    const directMessage = directPath === "message";
    const directMessageText = directPath === "message.text";
    const directMessageTextField = directPath === "message_text" || directPath === "message_text.text";
    const directBody = directPath === "body";
    const directBodyText = directPath === "body.text";
    const directStory = directPath === "story";
    const approvedDirectField = directMessage || directMessageText || directMessageTextField || directBody || directBodyText || directStory;
    const rootAuthorMessage = rootStoryBound && !underAttachment && !underMedia && !underShared && !underComment && !underAccessibility && approvedDirectField;
    const outerSelectable = rootAuthorMessage;
    const sharedSelectable = underShared && !underComment && !underAccessibility && approvedDirectField;
    const selectable = outerSelectable || sharedSelectable;
    const priority = directMessage ? 500 : directMessageText || directMessageTextField ? 450 : directBodyText ? 440 : directBody ? 430 : directStory ? 400 : 0;
    const layer: FacebookPostTextLayer = underComment ? "COMMENT_TEXT"
      : underShared ? "SHARED_POST_TEXT"
        : underMedia ? "MEDIA_TEXT"
          : underAttachment ? "ATTACHMENT_TEXT"
            : outerSelectable ? "OUTER_POST_TEXT" : "IGNORED_TEXT";
    const category = underComment ? "COMMENT_TEXT"
      : underShared ? "SHARED_CONTENT_TEXT"
        : underMedia ? "MEDIA_TEXT"
          : underAttachment ? "ATTACHMENT_TEXT"
            : directMessage ? "DIRECT_POST_MESSAGE"
      : directMessageText ? "DIRECT_POST_MESSAGE_TEXT"
        : directBodyText ? "DIRECT_POST_BODY_TEXT"
          : directBody ? "DIRECT_POST_BODY"
            : directStory ? "DIRECT_POST_STORY"
              : underAccessibility ? "ACCESSIBILITY_TEXT" : "NESTED_POST_TEXT";
    const signals = inspectFacebookIntentSignals(text);
    candidates.push({
      text,
      priority,
      selectable,
      field_path_category: category,
      text_layer: layer,
      field_name: fieldName,
      text_length: text.length,
      nesting_depth: depth,
      direct_post_field: outerSelectable,
      under_attachment: underAttachment,
      under_shared: underShared,
      under_media: underMedia,
      under_comment: underComment,
      root_story_bound: rootStoryBound,
      root_author_message: rootAuthorMessage,
      buy_signals: signals.buySignals,
      sell_signals: signals.sellSignals,
    });
  };
  const collectLinkedCandidates = (value: unknown, path: string[], depth: number, inheritedPath: string[], rootStoryBound: boolean): void => {
    if (depth > 15 || value === null || value === undefined) return;
    if (Array.isArray(value)) { for (const item of value) collectLinkedCandidates(item, path, depth + 1, inheritedPath, rootStoryBound); return; }
    const row = record(value); if (!row) return;
    const nestedId = directPostId(row);
    const explicitEmbeddedContext = path.some((item) => sharedKey.test(item) || attachmentKey.test(item) || mediaKey.test(item));
    if (path.some((item) => sharedKey.test(item))) sharedContentDetected = true;
    if (depth > 0 && nestedId !== undefined && String(nestedId) !== expectedPostId && !explicitEmbeddedContext) return;
    for (const [key, item] of Object.entries(row)) {
      const nextPath = [...path, key];
      if (sharedKey.test(key)) sharedContentDetected = true;
      if (typeof item === "string" && textualKey.test(key)) addCandidate(item, key, nextPath, depth, inheritedPath, rootStoryBound);
      else if (item && typeof item === "object") collectLinkedCandidates(item, nextPath, depth + 1, inheritedPath, rootStoryBound);
    }
  };
  const matchedRows = new Set<Record<string, unknown>>();
  const visit = (value: unknown, depth: number, path: string[]): void => {
    if (depth > 30 || value === null || value === undefined) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1, path); return; }
    const row = record(value); if (!row) return;
    const matched = Object.entries(row).some(([key, item]) => idKey.test(key) && (typeof item === "string" || typeof item === "number") && String(item) === expectedPostId);
    if (matched && !matchedRows.has(row)) {
      matchedRows.add(row);
      const rootStoryBound = String(directPostId(row)) === expectedPostId && Object.keys(row).some((key) => authorKey.test(key));
      if (rootStoryBound) rootStoryIdentified = true;
      collectLinkedCandidates(row, [], 0, path, rootStoryBound);
    }
    for (const [key, item] of Object.entries(row)) if (item && typeof item === "object") visit(item, depth + 1, [...path, key]);
  };
  for (const value of values) visit(value, 0, []);
  const ranked = (layer: FacebookPostTextLayer) => candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.selectable && candidate.text_layer === layer)
    .sort((left, right) => right.candidate.priority - left.candidate.priority || right.candidate.text.length - left.candidate.text.length)[0];
  const selectedOuter = ranked("OUTER_POST_TEXT");
  const selectedShared = ranked("SHARED_POST_TEXT");
  const selected = selectedOuter ?? selectedShared;
  const longest = (layer: FacebookPostTextLayer) => candidates.filter((candidate) => candidate.text_layer === layer).sort((left, right) => right.text.length - left.text.length)[0]?.text ?? "";
  return {
    text: selected?.candidate.text ?? "",
    outerText: selectedOuter?.candidate.text ?? "",
    sharedText: selectedShared?.candidate.text ?? "",
    attachmentText: longest("ATTACHMENT_TEXT"),
    mediaText: longest("MEDIA_TEXT"),
    rootStoryIdentified,
    rootAuthorMessageIdentified: Boolean(selectedOuter),
    sharedContentDetected,
    candidates: candidates.map(({ text: _text, priority: _priority, selectable: _selectable, ...diagnostic }) => diagnostic),
    selectedCandidateIndex: selected?.index ?? null,
    selectedReason: selectedOuter ? selectedOuter.candidate.field_path_category : selectedShared ? "SHARED_POST_FALLBACK" : "NO_APPROVED_DIRECT_POST_TEXT_FIELD",
  };
}

export function extractFacebookAuthoritativeTextFromStructuredData(values: unknown[], expectedPostId: string): string {
  return extractFacebookAuthoritativeTextResolutionFromStructuredData(values, expectedPostId).text;
}

export type FacebookAuthoritativeTextResolutionContext = {
  sharedContentDetected?: boolean;
  metadataRootAuthorIdentified?: boolean;
  domRootAuthorIdentified?: boolean;
  rootStoryIdentified?: boolean;
};

export function resolveFacebookAuthoritativeTextSources(metadataText: string, domText: string, metadataSharedText = "", domSharedText = "", context: FacebookAuthoritativeTextResolutionContext = {}): FacebookAuthoritativeTextSourceResolution {
  const metadataRootText = context.metadataRootAuthorIdentified === false ? "" : metadataText;
  const domRootText = context.domRootAuthorIdentified === false ? "" : domText;
  const sharedContentDetected = context.sharedContentDetected ?? Boolean(metadataSharedText || domSharedText);
  const rootStoryIdentified = context.rootStoryIdentified ?? Boolean(metadataRootText || domRootText);
  const metadataSignals = inspectFacebookIntentSignals(metadataRootText);
  const domSignals = inspectFacebookIntentSignals(domRootText);
  const orientation = (buy: FacebookIntentSignalName[], sell: FacebookIntentSignalName[]) => buy.length > 0 && sell.length === 0 ? "BUY" : sell.length > 0 && buy.length === 0 ? "SELL" : "NONE";
  const metadataOrientation = orientation(metadataSignals.buySignals, metadataSignals.sellSignals);
  const domOrientation = orientation(domSignals.buySignals, domSignals.sellSignals);
  const conflict = metadataOrientation !== "NONE" && domOrientation !== "NONE" && metadataOrientation !== domOrientation;
  const sharedMetadataSignals = inspectFacebookIntentSignals(metadataSharedText);
  const sharedDomSignals = inspectFacebookIntentSignals(domSharedText);
  const outerAvailable = Boolean(metadataRootText || domRootText);
  const sharedConflict = !outerAvailable
    && orientation(sharedMetadataSignals.buySignals, sharedMetadataSignals.sellSignals) !== "NONE"
    && orientation(sharedDomSignals.buySignals, sharedDomSignals.sellSignals) !== "NONE"
    && orientation(sharedMetadataSignals.buySignals, sharedMetadataSignals.sellSignals) !== orientation(sharedDomSignals.buySignals, sharedDomSignals.sellSignals);
  const ambiguousComposite = sharedContentDetected && !outerAvailable && !rootStoryIdentified;
  const selected = conflict || sharedConflict
    ? { text: "", source: "CONFLICT" as const, provenance: "AMBIGUOUS_COMPOSITE" as const }
    : ambiguousComposite
      ? { text: "", source: "NONE" as const, provenance: "AMBIGUOUS_COMPOSITE" as const }
      : metadataRootText ? { text: metadataRootText, source: "POST_PAGE_METADATA" as const, provenance: "ROOT_AUTHOR_MESSAGE" as const }
        : domRootText ? { text: domRootText, source: "POST_REGION_DOM" as const, provenance: "ROOT_AUTHOR_MESSAGE" as const }
          : rootStoryIdentified && metadataSharedText ? { text: metadataSharedText, source: "SHARED_POST_FALLBACK" as const, provenance: "SHARED_CONTENT_ONLY" as const }
            : rootStoryIdentified && domSharedText ? { text: domSharedText, source: "SHARED_POST_FALLBACK" as const, provenance: "SHARED_CONTENT_ONLY" as const }
              : { text: "", source: "NONE" as const, provenance: "NONE" as const };
  const selectedLayer = selected.provenance === "ROOT_AUTHOR_MESSAGE" ? "ROOT_AUTHOR_MESSAGE"
    : selected.provenance === "SHARED_CONTENT_ONLY" ? "SHARED_CONTENT_TEXT"
      : selected.provenance === "AMBIGUOUS_COMPOSITE" ? "AMBIGUOUS_COMPOSITE"
        : "NONE";
  return { ...selected, metadataBuySignals: metadataSignals.buySignals, metadataSellSignals: metadataSignals.sellSignals, domBuySignals: domSignals.buySignals, domSellSignals: domSignals.sellSignals, conflict: conflict || sharedConflict, selectedLayer };
}

async function extractFacebookAuthoritativeTextFromMetadata(page: Page, postId: string): Promise<FacebookMetadataTextResolution> {
  const sources = await page.locator('script[type="application/ld+json"],script[type="application/json"]').evaluateAll((scripts, targetPostId) => scripts
    .map((script) => script.textContent ?? "")
    .filter((source) => source.length > 0 && source.length <= 2_000_000 && source.includes(targetPostId))
    .slice(0, 100), postId);
  const values = sources.flatMap((source) => { try { return [JSON.parse(source) as unknown]; } catch { return []; } });
  const resolution = extractFacebookAuthoritativeTextResolutionFromStructuredData(values, postId);
  logFacebookWorker("FACEBOOK_METADATA_TEXT_CANDIDATES_DIAGNOSTIC", {
    post_id: postId,
    candidates: resolution.candidates.slice(0, 50),
    selected_candidate_index: resolution.selectedCandidateIndex,
    selected_reason: resolution.selectedReason,
  });
  return resolution;
}

export type FacebookDomPostTextLayers = {
  outerText: string;
  sharedText: string;
  attachmentText: string;
  mediaText: string;
  sharedContentDetected: boolean;
  rootStoryIdentified: boolean;
  rootAuthorMessageIdentified: boolean;
};

async function extractFacebookPostTextLayersFromDom(page: Page, captureToken: string, postId: string, commentBoundaryY: number | null): Promise<FacebookDomPostTextLayers> {
  return page.evaluate(({ captureToken: token, expectedPostId, commentBoundary }) => {
    const empty = { outerText: "", sharedText: "", attachmentText: "", mediaText: "", sharedContentDetected: false, rootStoryIdentified: false, rootAuthorMessageIdentified: false };
    const selectedRoot = document.querySelector<HTMLElement>(`[data-flip-facebook-capture="${token}"]`);
    const main = document.querySelector<HTMLElement>('main,[role="main"]') ?? document.body;
    if (!selectedRoot || !main) return empty;
    const commentSelector = '[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i]';
    const excludedSelector = 'nav,header,aside,[role="navigation"],[role="banner"],[role="complementary"],[role="toolbar"],form,button,[role="button"]';
    const dedicatedSelector = '[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-testid="post_message"],[data-testid="post-message"]';
    const candidateSelector = `${dedicatedSelector},div[dir="auto"],p,[data-lexical-text="true"]`;
    const sharedSelector = '[data-testid*="shared" i],[data-testid*="reshare" i],[data-ad-preview*="attachment" i],[data-ad-comet-preview*="attachment" i],blockquote';
    const rootAuthorSelector = '[data-testid*="post-author" i],[data-testid*="story-author" i],[data-testid*="actor" i],[data-testid*="composer" i],[data-pagelet*="author" i]';
    const attachmentSelector = '[data-testid*="attachment" i],[data-ad-preview*="attachment" i],[data-ad-comet-preview*="attachment" i]';
    const mediaSelector = 'picture,video,[role="img"],[style*="background-image"]';
    const uiOnly = /^(?:lubię to!?|like|odpowiedz|reply|udostępnij|share|wyślij|send|więcej|see more)$/iu;
    const selectedRect = selectedRoot.getBoundingClientRect();
    const overlapRatio = (rect: DOMRect) => Math.max(0, Math.min(rect.right, selectedRect.right) - Math.max(rect.left, selectedRect.left)) / Math.max(1, Math.min(rect.width, selectedRect.width));
    const explicitSharedRoots = Array.from(main.querySelectorAll<HTMLElement>(sharedSelector));
    for (const anchor of Array.from(main.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"][href*="/posts/"]'))) {
      try {
        const match = new URL(anchor.href, location.href).pathname.match(/\/posts\/(\d+)/i);
        if (!match || match[1] === expectedPostId || new URL(anchor.href, location.href).searchParams.has("comment_id")) continue;
        let ancestor: HTMLElement | null = anchor;
        for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
          const rect = ancestor.getBoundingClientRect();
          if (rect.width >= 250 && rect.height >= 100) { explicitSharedRoots.push(ancestor); break; }
        }
      } catch { /* Ignore malformed hrefs. */ }
    }
    const uniqueSharedRoots = explicitSharedRoots.filter((root, index) => explicitSharedRoots.indexOf(root) === index);
    const rootStorySelector = '[data-testid*="root-story" i],[data-pagelet*="story" i],[data-pagelet*="feedunit" i]';
    const rootStoryContainers = Array.from(main.querySelectorAll<HTMLElement>(rootStorySelector));
    if (selectedRoot.matches(rootStorySelector)) rootStoryContainers.push(selectedRoot);
    const rootStoryFor = (element: HTMLElement) => {
      const closest = element.closest<HTMLElement>(rootStorySelector);
      return closest?.querySelector(rootAuthorSelector) ? closest : null;
    };
    type Candidate = { text: string; order: number; dedicated: boolean; rect: DOMRect; insideSelected: boolean; insideShared: boolean; insideAttachment: boolean; insideMedia: boolean; rootAuthorBound: boolean };
    const candidates = Array.from(main.querySelectorAll<HTMLElement>(candidateSelector)).flatMap((element, order): Candidate[] => {
      if (element.closest(commentSelector) || element.closest(excludedSelector)) return [];
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const pageTop = rect.top + window.scrollY;
      if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return [];
      if (commentBoundary !== null && pageTop >= commentBoundary - 1) return [];
      const text = element.innerText.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line.length > 0 && !uiOnly.test(line)).join(" ").trim();
      if (text.length < 8 || text.length > 5_000) return [];
      const insideShared = uniqueSharedRoots.some((root) => root.contains(element));
      const rootAuthorBound = element.matches(dedicatedSelector) && !insideShared && Boolean(rootStoryFor(element));
      return [{
        text: text.slice(0, 2_000), order, dedicated: element.matches(dedicatedSelector), rect,
        insideSelected: selectedRoot.contains(element),
        insideShared,
        insideAttachment: Boolean(element.closest(attachmentSelector)),
        insideMedia: Boolean(element.closest(mediaSelector)),
        rootAuthorBound,
      }];
    });
    const outerAboveSelected = candidates.filter((candidate) => candidate.rootAuthorBound && !candidate.insideSelected
      && candidate.rect.bottom <= selectedRect.top + 16
      && selectedRect.top - candidate.rect.bottom <= 500
      && overlapRatio(candidate.rect) >= 0.5);
    const firstSharedTop = uniqueSharedRoots.reduce((top, root) => Math.min(top, root.getBoundingClientRect().top), Number.POSITIVE_INFINITY);
    const outerInsideComposite = candidates.filter((candidate) => candidate.rootAuthorBound && candidate.insideSelected && !candidate.insideShared
      && (!Number.isFinite(firstSharedTop) || candidate.rect.bottom <= firstSharedTop + 8));
    const outerCandidates = [...outerAboveSelected, ...outerInsideComposite];
    const geometryComposite = outerAboveSelected.length > 0 && candidates.some((candidate) => candidate.insideSelected);
    const sharedContentDetected = uniqueSharedRoots.length > 0 || geometryComposite;
    const sharedCandidates = candidates.filter((candidate) => candidate.insideShared || geometryComposite && candidate.insideSelected);
    const attachmentCandidates = candidates.filter((candidate) => candidate.insideAttachment && !candidate.insideShared);
    const mediaCandidates = candidates.filter((candidate) => candidate.insideMedia && !candidate.insideShared);
    const pick = (pool: Candidate[]) => {
      const unique = pool.filter((candidate, index) => pool.findIndex((other) => other.text === candidate.text) === index);
      return unique.sort((left, right) => Number(right.dedicated) - Number(left.dedicated) || right.text.length - left.text.length || left.order - right.order)[0]?.text ?? "";
    };
    const rootStoryIdentified = rootStoryContainers.some((container) => container.querySelector(rootAuthorSelector));
    return {
      outerText: pick(outerCandidates),
      sharedText: pick(sharedCandidates),
      attachmentText: pick(attachmentCandidates),
      mediaText: pick(mediaCandidates),
      sharedContentDetected,
      rootStoryIdentified,
      rootAuthorMessageIdentified: outerCandidates.length > 0,
    };
  }, { captureToken, expectedPostId: postId, commentBoundary: commentBoundaryY }).catch(() => ({ outerText: "", sharedText: "", attachmentText: "", mediaText: "", sharedContentDetected: false, rootStoryIdentified: false, rootAuthorMessageIdentified: false }));
}

export function canonicalFacebookPostUrl(value: string, expectedPostId?: string): DiscoveredFacebookPost | null {
  try {
    const url = new URL(value, "https://www.facebook.com");
    if (url.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/groups\/[^/]+\/posts\/(\d+)\/?$/i);
    if (!match || expectedPostId && match[1] !== expectedPostId) return null;
    url.hostname = "www.facebook.com"; url.pathname = url.pathname.replace(/\/$/, "") + "/"; url.search = ""; url.hash = "";
    return { postId: match[1], permalink: url.toString() };
  } catch { return null; }
}

export function discoverPostLinksFromHrefs(hrefs: string[], limit = MAX_FACEBOOK_POSTS_PER_JOB): DiscoveredFacebookPost[] {
  const unique = new Map<string, DiscoveredFacebookPost>();
  for (const href of hrefs) {
    const post = canonicalFacebookPostUrl(href);
    if (post && !unique.has(post.postId)) unique.set(post.postId, post);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

export function facebookPostFreshnessFailure(publishedAt: string | null, nowMs = Date.now()): FacebookPostFreshnessFailure | null {
  if (!publishedAt) return "FACEBOOK_POST_AGE_UNKNOWN";
  const publishedAtMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedAtMs) || publishedAtMs > nowMs + 5 * 60 * 1_000) return "FACEBOOK_POST_AGE_UNKNOWN";
  return nowMs - publishedAtMs <= FACEBOOK_POST_MAX_AGE_MS ? null : "FACEBOOK_POST_TOO_OLD";
}

export function freshFacebookPosts(posts: FreshDiscoveredFacebookPost[]): FreshDiscoveredFacebookPost[] {
  return posts.filter((post) => post.freshnessFailure === null);
}

export function limitFacebookVisionPosts(posts: FreshDiscoveredFacebookPost[], limit = MAX_VISION_POSTS_PER_JOB): { selected: FreshDiscoveredFacebookPost[]; remainingFreshCount: number } {
  const selected = posts.slice(0, limit);
  return { selected, remainingFreshCount: Math.max(0, posts.length - selected.length) };
}

export function parseFacebookMaxPostsArgument(argv: string[]): number | null {
  const raw = argv.find((argument) => argument.startsWith("--max-facebook-posts="))?.split("=", 2)[1];
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_VISION_POSTS_PER_JOB) throw new Error(`--max-facebook-posts must be an integer between 1 and ${MAX_VISION_POSTS_PER_JOB}.`);
  return value;
}

export function parseFacebookPostIdArgument(argv: string[]): string | null {
  const argumentsWithValue = argv.filter((argument) => argument.startsWith("--facebook-post-id="));
  if (argumentsWithValue.length === 0) return null;
  if (argumentsWithValue.length > 1) throw new Error("--facebook-post-id may be provided only once.");
  const postId = argumentsWithValue[0].slice("--facebook-post-id=".length);
  if (!/^\d+$/.test(postId)) throw new Error("--facebook-post-id must contain only digits.");
  return postId;
}

export function createFacebookDebugTarget(groupUrlValue: string, postId: string): FreshDiscoveredFacebookPost {
  const groupUrl = new URL(groupUrlValue);
  if (groupUrl.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(groupUrl.hostname)) throw new Error("Facebook debug target requires a Facebook group URL.");
  const groupPath = groupUrl.pathname.match(/^\/groups\/([^/]+)/i);
  if (!groupPath) throw new Error("Facebook debug target requires a Facebook group URL.");
  const post = canonicalFacebookPostUrl(`https://www.facebook.com/groups/${groupPath[1]}/posts/${postId}/`, postId);
  if (!post) throw new Error("Unable to create the Facebook debug target URL.");
  return { ...post, discoveredPublishedAt: null, freshnessFailure: "FACEBOOK_POST_AGE_UNKNOWN" };
}

export function isExpectedFacebookPostPage(pageUrl: string, postId: string): boolean {
  try { return new RegExp(`/groups/[^/]+/posts/${postId}/?$`, "i").test(new URL(pageUrl).pathname); }
  catch { return false; }
}

export async function resolveFacebookPostDiscovery(input: {
  groupUrl: string;
  debugPostId: string | null;
  discover: () => Promise<FacebookDiscoveryLoopResult>;
}): Promise<FacebookDiscoveryLoopResult> {
  if (input.debugPostId) {
    return { posts: [createFacebookDebugTarget(input.groupUrl, input.debugPostId)], scrollCount: 0, stopReason: "DEBUG_TARGET" };
  }
  return input.discover();
}

export function parseFacebookTimestampValue(value: string | null, nowMs = Date.now()): string | null {
  if (!value) return null;
  const normalized = value.trim().toLocaleLowerCase("pl-PL").normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ");
  if (/^\d{9,13}$/.test(normalized)) {
    const numeric = Number(normalized);
    const timestamp = normalized.length <= 10 ? numeric * 1_000 : numeric;
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  const relative = normalized.match(/^(\d+)\s*(min(?:ut(?:a|y|e)?)?|m|godz(?:\.|in(?:a|y|e)?)?|hours?|hrs?|h|dni|dzien|days?|d)(?:\s+temu|\s+ago)?$/u);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const multiplier = unit.startsWith("min") || unit === "m" ? 60_000 : unit.startsWith("godz") || unit.startsWith("hour") || unit.startsWith("hr") || unit === "h" ? 60 * 60_000 : 24 * 60 * 60_000;
    return new Date(nowMs - amount * multiplier).toISOString();
  }
  const yesterday = normalized.match(/^(?:wczoraj|yesterday)(?:\s+(?:(?:o|at)\s+)?(\d{1,2}):(\d{2}))?$/u);
  if (yesterday) {
    const date = new Date(nowMs);
    date.setDate(date.getDate() - 1);
    date.setHours(Number(yesterday[1] ?? 0), Number(yesterday[2] ?? 0), 0, 0);
    return date.toISOString();
  }
  const months: Record<string, number> = { stycznia: 0, january: 0, jan: 0, lutego: 1, february: 1, feb: 1, marca: 2, march: 2, mar: 2, kwietnia: 3, april: 3, apr: 3, maja: 4, may: 4, czerwca: 5, june: 5, jun: 5, lipca: 6, july: 6, jul: 6, sierpnia: 7, august: 7, aug: 7, wrzesnia: 8, september: 8, sep: 8, pazdziernika: 9, october: 9, oct: 9, listopada: 10, november: 10, nov: 10, grudnia: 11, december: 11, dec: 11 };
  const dayFirst = normalized.match(/^(\d{1,2})\s+(\p{L}+)(?:\s+(\d{4}))?(?:\s+(?:(?:o|at)\s+)?(\d{1,2}):(\d{2}))?$/u);
  const monthFirst = normalized.match(/^(\p{L}+)\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+(?:(?:o|at)\s+)?(\d{1,2}):(\d{2}))?$/u);
  const absolute = dayFirst ? { day: dayFirst[1], month: dayFirst[2], year: dayFirst[3], hour: dayFirst[4], minute: dayFirst[5] } : monthFirst ? { day: monthFirst[2], month: monthFirst[1], year: monthFirst[3], hour: monthFirst[4], minute: monthFirst[5] } : null;
  if (!absolute || months[absolute.month] === undefined) {
    const directTimestamp = /^\d{4}-\d{2}-\d{2}(?:[T\s].+)?$/u.test(normalized) ? Date.parse(value) : Number.NaN;
    return Number.isFinite(directTimestamp) ? new Date(directTimestamp).toISOString() : null;
  }
  const now = new Date(nowMs);
  let year = absolute.year ? Number(absolute.year) : now.getFullYear();
  let date = new Date(year, months[absolute.month], Number(absolute.day), Number(absolute.hour ?? 0), Number(absolute.minute ?? 0));
  if (!absolute.year && date.getTime() > nowMs + 5 * 60_000) {
    year -= 1;
    date = new Date(year, months[absolute.month], Number(absolute.day), Number(absolute.hour ?? 0), Number(absolute.minute ?? 0));
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function resolveFacebookPostAge(post: FreshDiscoveredFacebookPost, nowMs: number, fallback: () => Promise<string | null | FacebookPostAgeFallback>): Promise<FacebookPostAgeResolution> {
  const feedPublishedAt = post.discoveredPublishedAt;
  const fallbackResult = feedPublishedAt ? null : await fallback();
  const publishedAt = feedPublishedAt ?? (typeof fallbackResult === "string" || fallbackResult === null ? fallbackResult : fallbackResult.publishedAt);
  const source: FacebookPostAgeSource = feedPublishedAt ? "FEED" : typeof fallbackResult === "object" && fallbackResult ? fallbackResult.source : "POST_PAGE";
  const freshnessFailure = facebookPostFreshnessFailure(publishedAt, nowMs);
  const resolvedPost = { ...post, discoveredPublishedAt: publishedAt, freshnessFailure };
  const ageHours = publishedAt ? Math.max(0, (nowMs - Date.parse(publishedAt)) / (60 * 60_000)) : null;
  return { post: resolvedPost, source, ageHours: ageHours !== null && Number.isFinite(ageHours) ? ageHours : null, decision: freshnessFailure === null ? "PROCESS" : freshnessFailure === "FACEBOOK_POST_TOO_OLD" ? "TOO_OLD" : "UNKNOWN" };
}

export function resolveFacebookPostAgeFromCache(post: FreshDiscoveredFacebookPost, hit: FacebookAgeCacheHit, nowMs: number): FacebookPostAgeResolution {
  const freshnessFailure = facebookPostFreshnessFailure(hit.publishedAt, nowMs);
  const resolvedPost = { ...post, discoveredPublishedAt: hit.publishedAt, freshnessFailure };
  const publishedAtMs = hit.publishedAt ? Date.parse(hit.publishedAt) : Number.NaN;
  const ageHours = Number.isFinite(publishedAtMs) ? Math.max(0, (nowMs - publishedAtMs) / (60 * 60_000)) : null;
  return { post: resolvedPost, source: "AGE_CACHE", ageHours, decision: freshnessFailure === null ? "PROCESS" : freshnessFailure === "FACEBOOK_POST_TOO_OLD" ? "TOO_OLD" : "UNKNOWN" };
}

/**
 * Debug-target runs deliberately inspect one explicit post.  Keep the normal
 * freshness resolver and its cache semantics untouched; only the exact
 * command-line target may continue past the age gate.
 */
export function applyFacebookTargetedFreshnessBypass(
  resolution: FacebookPostAgeResolution,
  debugPostId: string | null,
): FacebookPostAgeResolution {
  if (!debugPostId || resolution.post.postId !== debugPostId) return resolution;

  return {
    ...resolution,
    post: { ...resolution.post, freshnessFailure: null },
    decision: "PROCESS",
  };
}

type FeedTimestampCandidate = { value: string; source: string; bindingMethod: string; machineReadable: boolean; priority: number };

function isFeedDateWithoutTime(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase("pl-PL").normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ");
  if (/^(?:wczoraj|yesterday)$/u.test(normalized)) return true;
  if (/^\d+\s*(?:min(?:ut(?:a|y|e)?)?|m|godz(?:\.|in(?:a|y|e)?)?|hours?|hrs?|h|dni|dzien|days?|d)(?:\s+temu|\s+ago)?$/u.test(normalized)) return false;
  return !/\d{1,2}:\d{2}/u.test(normalized)
    && (/^\d{1,2}\s+\p{L}+(?:\s+\d{4})?$/u.test(normalized) || /^\p{L}+\s+\d{1,2}(?:,?\s+\d{4})?$/u.test(normalized));
}

function resolveFeedTimestampCandidates(candidates: FeedTimestampCandidate[], nowMs: number): { publishedAt: string | null; selected: FeedTimestampCandidate | null; rejectionReason: FacebookFeedAgeDiagnostic["rejectionReason"] } {
  const unique = [...new Map(candidates.map((candidate) => [`${candidate.source}:${candidate.value}`, candidate])).values()];
  const parsed = unique.flatMap((candidate) => {
    const publishedAt = parseFacebookTimestampValue(candidate.value, nowMs);
    if (!publishedAt) return [];
    const timestamp = Date.parse(publishedAt);
    if (!Number.isFinite(timestamp) || timestamp > nowMs + 5 * 60_000 || timestamp < Date.UTC(2004, 0, 1)) return [];
    if (!isFeedDateWithoutTime(candidate.value)) return [{ candidate, timestamp, boundaryAmbiguous: false }];
    const date = new Date(timestamp);
    const earliest = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0).getTime();
    const latest = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999).getTime();
    const threshold = nowMs - FACEBOOK_POST_MAX_AGE_MS;
    if (earliest <= threshold && latest >= threshold) return [{ candidate, timestamp, boundaryAmbiguous: true }];
    return [{ candidate, timestamp: latest < threshold ? latest : earliest, boundaryAmbiguous: false }];
  });
  if (parsed.length === 0) return { publishedAt: null, selected: null, rejectionReason: unique.length ? "INVALID_TIMESTAMP" : "NO_TIMESTAMP" };
  const bestPriority = Math.min(...parsed.map((item) => item.candidate.priority));
  const preferred = parsed.filter((item) => item.candidate.priority === bestPriority);
  if (preferred.some((item) => item.boundaryAmbiguous)) return { publishedAt: null, selected: null, rejectionReason: "DATE_PRECISION_CROSSES_72H" };
  const timestamps = [...new Set(preferred.map((item) => item.timestamp))];
  if (timestamps.length > 1 && Math.max(...timestamps) - Math.min(...timestamps) > 5 * 60_000) return { publishedAt: null, selected: null, rejectionReason: "AMBIGUOUS_TIMESTAMP" };
  return { publishedAt: new Date(Math.min(...timestamps)).toISOString(), selected: preferred[0].candidate, rejectionReason: null };
}

export async function discoverFacebookPosts(page: Page, limit = MAX_FACEBOOK_POSTS_PER_JOB, nowMs = Date.now()): Promise<FreshDiscoveredFacebookPost[]> {
  const records = await page.locator('a[href*="/groups/"][href*="/posts/"]').evaluateAll((links) => {
    type Candidate = { value: string; source: string; bindingMethod: string; machineReadable: boolean; priority: number };
    type Record = { href: string; candidates: Candidate[]; rejectionReason: "COMMENT_CONTEXT" | "SHARED_OR_ATTACHMENT_CONTEXT" | "ADJACENT_POST_AMBIGUITY" | null };
    const postIdFromHref = (href: string) => { try { return new URL(href, location.href).pathname.match(/\/groups\/[^/]+\/posts\/(\d+)/i)?.[1] ?? null; } catch { return null; } };
    const marker = (element: Element) => [element.getAttribute("role"), element.getAttribute("data-testid"), element.getAttribute("data-pagelet"), element.getAttribute("aria-label")].filter(Boolean).join(" ").toLocaleLowerCase("pl-PL");
    const pathHas = (element: Element, pattern: RegExp) => { for (let current: Element | null = element, depth = 0; current && depth < 12; current = current.parentElement, depth += 1) if (pattern.test(marker(current))) return true; return false; };
    const nestedArticle = (element: Element) => { const article = element.closest('[role="article"]'); return Boolean(article?.parentElement?.closest('[role="article"]')); };
    const commentContext = (element: Element) => nestedArticle(element) || pathHas(element, /comment|reply|komentar|odpowied/i);
    const sharedContext = (element: Element) => pathHas(element, /attachment|shared|reshar|substory|media.?overlay|photo.?viewer/i);
    const add = (list: Candidate[], value: string | null, source: string, bindingMethod: string, machineReadable: boolean, priority: number) => {
      const trimmed = value?.trim(); if (trimmed && trimmed.length <= 160 && !list.some((item) => item.source === source && item.value === trimmed)) list.push({ value: trimmed, source, bindingMethod, machineReadable, priority });
    };
    const looksLikeTimestampText = (value: string | null) => {
      const normalized = value?.trim().toLocaleLowerCase("pl-PL").normalize("NFKD").replace(/\p{M}/gu, "").replace(/\s+/g, " ") ?? "";
      return /^(?:wczoraj|yesterday)(?:\s+(?:(?:o|at)\s+)?\d{1,2}:\d{2})?$/u.test(normalized)
        || /^\d+\s*(?:min(?:ut(?:a|y)?)?|m|godz(?:in(?:a|y)?)?|godz\.?|h|dni|dzien|d|minutes?|mins?|hours?|hrs?|days?)(?:\s+temu|\s+ago)?$/u.test(normalized)
        || /^\d{1,2}\s+\p{L}+(?:\s+\d{4})?(?:\s+(?:(?:o|at)\s+)?\d{1,2}:\d{2})?$/u.test(normalized)
        || /^\p{L}+\s+\d{1,2}(?:,?\s+\d{4})?(?:\s+(?:(?:o|at)\s+)?\d{1,2}:\d{2})?$/u.test(normalized);
    };
    const collectFromNode = (list: Candidate[], node: Element, sourcePrefix: string, bindingMethod: string, allowText: boolean) => {
      for (const attribute of Array.from(node.attributes)) if (/^(?:datetime|data-(?:utime|timestamp|time|date))$/i.test(attribute.name)) add(list, attribute.value, `${sourcePrefix}_MACHINE`, bindingMethod, true, 0);
      add(list, node.getAttribute("aria-label"), `${sourcePrefix}_ARIA_LABEL`, bindingMethod, false, 1);
      add(list, node.getAttribute("title"), `${sourcePrefix}_TITLE`, bindingMethod, false, 1);
      if (allowText && looksLikeTimestampText(node.textContent)) add(list, node.textContent, `${sourcePrefix}_TEXT`, bindingMethod, false, 2);
    };
    return links.map((element): Record => {
      const link = element as HTMLAnchorElement; const url = new URL(link.href, location.href); const postId = postIdFromHref(link.href);
      if (!postId || url.searchParams.has("comment_id") || commentContext(link)) return { href: link.href, candidates: [], rejectionReason: "COMMENT_CONTEXT" };
      if (sharedContext(link)) return { href: link.href, candidates: [], rejectionReason: "SHARED_OR_ATTACHMENT_CONTEXT" };
      const candidates: Candidate[] = [];
      collectFromNode(candidates, link, "PERMALINK", "EXACT_PERMALINK", true);
      for (const node of Array.from(link.querySelectorAll<HTMLElement>('time,abbr,[datetime],[data-utime],[data-timestamp],[data-time],[data-date],[aria-label],[title]')).slice(0, 30)) {
        if (!commentContext(node) && !sharedContext(node)) collectFromNode(candidates, node, "PERMALINK_DESCENDANT", "EXACT_PERMALINK", node.matches("time,abbr"));
      }
      let foundExactRoot = false; let sawAdjacentPosts = false;
      for (let root = link.parentElement, depth = 0; root && depth < 10 && root !== document.body; root = root.parentElement, depth += 1) {
        if (commentContext(root) || sharedContext(root)) continue;
        const ids = new Set(Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"][href*="/posts/"]')).filter((anchor) => { try { return !new URL(anchor.href, location.href).searchParams.has("comment_id"); } catch { return false; } }).map((anchor) => postIdFromHref(anchor.href)).filter((id): id is string => Boolean(id)));
        if (ids.size !== 1 || !ids.has(postId)) { if (ids.size > 1) sawAdjacentPosts = true; continue; }
        const nodes = Array.from(root.querySelectorAll<HTMLElement>('time,abbr,[datetime],[data-utime],[data-timestamp],[data-time],[data-date],a[aria-label],a[title],span[aria-label],span[title],span[dir="auto"]')).slice(0, 80);
        const safeNodes = nodes.filter((node) => !commentContext(node) && !sharedContext(node) && (!node.closest('a[href*="/groups/"][href*="/posts/"]') || postIdFromHref(node.closest<HTMLAnchorElement>('a[href*="/groups/"][href*="/posts/"]')!.href) === postId));
        if (safeNodes.length === 0) continue;
        for (const node of safeNodes) collectFromNode(candidates, node, "ROOT_STORY", "EXACT_COMMON_ROOT_STORY", node.matches("time,abbr,span[dir=auto]") && (node.textContent?.trim().length ?? 0) <= 40);
        foundExactRoot = true; break;
      }
      return { href: link.href, candidates, rejectionReason: candidates.length ? null : sawAdjacentPosts && !foundExactRoot ? "ADJACENT_POST_AMBIGUITY" : null };
    });
  });
  const requestedPostIds = [...new Set(records.map((record) => canonicalFacebookPostUrl(record.href)?.postId).filter((postId): postId is string => Boolean(postId)))];
  const structuredValues = await page.evaluate((postIds) => {
    const requested = new Set(postIds);
    const result: Record<string, Array<{ value: string; source: string; bindingMethod: string; machineReadable: boolean; priority: number }>> = {};
    const forbiddenPath = /comment|reply|attachment|media|photo|video|share|reshar|recommend|sidebar/i;
    const idKey = /^(?:id|post_id|postId|story_fbid|top_level_post_id)$/;
    const timeKey = /^(?:creation_time|publish_time|timestamp)$/i;
    const visit = (value: unknown, path: string[], depth: number) => {
      if (!value || typeof value !== "object" || depth > 25) return;
      if (Array.isArray(value)) { value.forEach((item) => visit(item, path, depth + 1)); return; }
      const entries = Object.entries(value as Record<string, unknown>);
      const directId = entries.find(([key, item]) => idKey.test(key) && (typeof item === "string" || typeof item === "number") && requested.has(String(item)))?.[1];
      if (directId !== undefined && !path.some((part) => forbiddenPath.test(part))) {
        for (const [key, item] of entries) if (timeKey.test(key) && (typeof item === "string" || typeof item === "number")) {
          const id = String(directId); (result[id] ??= []).push({ value: String(item), source: `STRUCTURED_${key.toUpperCase()}`, bindingMethod: "EXACT_POST_METADATA", machineReadable: true, priority: 0 });
        }
      }
      for (const [key, item] of entries) if (item && typeof item === "object") visit(item, [...path, key], depth + 1);
    };
    document.querySelectorAll<HTMLScriptElement>('script[type="application/json"],script[type="application/ld+json"]').forEach((script) => {
      const source = script.textContent ?? "";
      if (!source || source.length > 2_000_000) return;
      try { visit(JSON.parse(source), [], 0); } catch { /* ambiguous inline scripts are not an age source */ }
    });
    return result;
  }, requestedPostIds);
  const unique = new Map<string, FreshDiscoveredFacebookPost>();
  for (const record of records) {
    const post = canonicalFacebookPostUrl(record.href);
    if (!post) continue;
    const rawCandidates = [...record.candidates, ...(structuredValues[post.postId] ?? [])];
    const resolved = resolveFeedTimestampCandidates(rawCandidates, nowMs);
    const publishedAt = resolved.publishedAt; const freshnessFailure = facebookPostFreshnessFailure(publishedAt, nowMs);
    const decision = freshnessFailure === null ? "PROCESS" : freshnessFailure === "FACEBOOK_POST_TOO_OLD" ? "TOO_OLD" : "UNKNOWN";
    const ageHours = publishedAt ? Math.max(0, (nowMs - Date.parse(publishedAt)) / 3_600_000) : null;
    const diagnosticRejection = resolved.rejectionReason === "NO_TIMESTAMP" && record.rejectionReason
      ? record.rejectionReason
      : resolved.rejectionReason ?? record.rejectionReason;
    const diagnostic: FacebookFeedAgeDiagnostic = { postId: post.postId, candidatesFound: rawCandidates.length, selectedSource: resolved.selected?.source ?? null, bindingMethod: resolved.selected?.bindingMethod ?? null, machineReadable: resolved.selected?.machineReadable ?? false, ageHours: ageHours === null ? null : Math.round(ageHours * 100) / 100, decision, rejectionReason: diagnosticRejection ?? "NO_TIMESTAMP" };
    const candidate = { ...post, discoveredPublishedAt: publishedAt, freshnessFailure, feedAgeDiagnostic: diagnostic };
    const existing = unique.get(post.postId);
    if (!existing || existing.freshnessFailure && !candidate.freshnessFailure || existing.freshnessFailure && candidate.feedAgeDiagnostic.candidatesFound > (existing.feedAgeDiagnostic?.candidatesFound ?? 0)) unique.set(post.postId, candidate);
  }
  return [...unique.values()].slice(0, limit);
}

function hasChronologicalOldBoundary(posts: FreshDiscoveredFacebookPost[], limit = 5): boolean {
  const dated = posts.filter((post) => post.discoveredPublishedAt !== null);
  if (dated.length < limit) return false;
  for (let index = 1; index < dated.length; index += 1) {
    if (Date.parse(dated[index].discoveredPublishedAt!) > Date.parse(dated[index - 1].discoveredPublishedAt!) + 5 * 60_000) return false;
  }
  return dated.slice(-limit).every((post) => post.freshnessFailure === "FACEBOOK_POST_TOO_OLD");
}

export async function runFacebookDiscoveryLoop(dependencies: {
  collect: () => Promise<FreshDiscoveredFacebookPost[]>;
  scroll: (scrollIndex: number) => Promise<{ moved: boolean; scrollY: number }>;
  heartbeat?: () => Promise<void>;
  onScroll?: (event: { scrollIndex: number; discoveredTotal: number; newPostCount: number; scrollY: number }) => void;
  lookupKnown?: (postIds: string[]) => Promise<Record<string, { publishedAt: string }>>;
}, limits: { maxPosts?: number; maxScrolls?: number; maxEmptyScrolls?: number } = {}): Promise<FacebookDiscoveryLoopResult> {
  const maxPosts = limits.maxPosts ?? MAX_FACEBOOK_DISCOVERED_POSTS;
  const maxScrolls = limits.maxScrolls ?? MAX_FACEBOOK_DISCOVERY_SCROLLS;
  const maxEmptyScrolls = limits.maxEmptyScrolls ?? MAX_FACEBOOK_EMPTY_SCROLLS;
  const unique = new Map<string, FreshDiscoveredFacebookPost>();
  const merge = (batch: FreshDiscoveredFacebookPost[]) => {
    let added = 0;
    for (const post of batch) {
      const existing = unique.get(post.postId);
      if (!existing && unique.size < maxPosts) { unique.set(post.postId, post); added += 1; }
      else if (existing?.freshnessFailure && !post.freshnessFailure) unique.set(post.postId, post);
    }
    return added;
  };
  merge(await dependencies.collect());
  const reachedKnownOldBoundary = async () => {
    if (!dependencies.lookupKnown || unique.size === 0) return false;
    const known = await dependencies.lookupKnown([...unique.keys()]);
    return shouldStopForKnownOldSequence([...unique.values()].map((post) => ({ postId: post.postId, publishedAt: post.discoveredPublishedAt ?? known[post.postId]?.publishedAt ?? null })), new Set(Object.keys(known)));
  };
  if (unique.size >= maxPosts) return { posts: [...unique.values()], scrollCount: 0, stopReason: "MAX_POSTS" };
  if (hasChronologicalOldBoundary([...unique.values()])) return { posts: [...unique.values()], scrollCount: 0, stopReason: "OLDER_THAN_72H" };
  if (await reachedKnownOldBoundary()) return { posts: [...unique.values()], scrollCount: 0, stopReason: "KNOWN_OLD_SEQUENCE" };
  let emptyScrolls = 0;
  for (let scrollIndex = 1; scrollIndex <= maxScrolls; scrollIndex += 1) {
    const movement = await dependencies.scroll(scrollIndex);
    await dependencies.heartbeat?.();
    const newPostCount = movement.moved ? merge(await dependencies.collect()) : 0;
    dependencies.onScroll?.({ scrollIndex, discoveredTotal: unique.size, newPostCount, scrollY: movement.scrollY });
    if (!movement.moved) return { posts: [...unique.values()], scrollCount: scrollIndex, stopReason: "END_OF_FEED" };
    emptyScrolls = newPostCount === 0 ? emptyScrolls + 1 : 0;
    if (unique.size >= maxPosts) return { posts: [...unique.values()], scrollCount: scrollIndex, stopReason: "MAX_POSTS" };
    if (hasChronologicalOldBoundary([...unique.values()])) return { posts: [...unique.values()], scrollCount: scrollIndex, stopReason: "OLDER_THAN_72H" };
    if (await reachedKnownOldBoundary()) return { posts: [...unique.values()], scrollCount: scrollIndex, stopReason: "KNOWN_OLD_SEQUENCE" };
    if (emptyScrolls >= maxEmptyScrolls) return { posts: [...unique.values()], scrollCount: scrollIndex, stopReason: "NO_NEW_POSTS" };
  }
  return { posts: [...unique.values()], scrollCount: maxScrolls, stopReason: "MAX_SCROLLS" };
}

export async function discoverFacebookPostsByScrolling(page: Page, nowMs = Date.now(), heartbeat?: () => Promise<void>, lookupKnown?: (postIds: string[]) => Promise<Record<string, { publishedAt: string }>>): Promise<FacebookDiscoveryLoopResult> {
  return runFacebookDiscoveryLoop({
    collect: () => discoverFacebookPosts(page, MAX_FACEBOOK_DISCOVERED_POSTS, nowMs),
    scroll: async () => {
      const before = await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight }));
      await page.evaluate(() => window.scrollBy({ top: Math.max(600, window.innerHeight * 0.85), behavior: "auto" }));
      await page.waitForTimeout(800);
      const after = await page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight }));
      return { moved: after.y > before.y || after.height > before.height, scrollY: after.y };
    },
    heartbeat,
    lookupKnown,
    onScroll: (event) => logFacebookWorker("FACEBOOK_DISCOVERY_SCROLL", { scrollIndex: event.scrollIndex, discoveredTotal: event.discoveredTotal, newPostCount: event.newPostCount, scrollY: Math.round(event.scrollY) }),
  });
}

export async function detectFacebookPostAgeOnDedicatedPage(page: Page, postId: string, nowMs = Date.now()): Promise<FacebookPostAgeFallback> {
  const metadataCandidates = await page.evaluate((targetPostId) => {
    const postPath = new RegExp(`/groups/[^/]+/posts/${targetPostId}/?$`, "i");
    if (!postPath.test(location.pathname)) return [];
    const results: Array<{ key: string; value: string; linked: boolean; depth: number }> = [];
    const timeKeys = new Set(["creation_time", "publish_time", "timestamp"]);
    const scalarMatchesPostId = (key: string, value: unknown) => /(?:^|_)(?:post_?)?id$/i.test(key) && String(value) === targetPostId;
    const visit = (value: unknown, depth: number): boolean => {
      if (!value || typeof value !== "object" || depth > 30) return false;
      if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1)).some(Boolean);
      const entries = Object.entries(value as Record<string, unknown>);
      const directMatch = entries.some(([key, item]) => typeof item !== "object" && scalarMatchesPostId(key, item));
      const childMatch = entries.filter(([, item]) => item && typeof item === "object").map(([, item]) => visit(item, depth + 1)).some(Boolean);
      const linked = directMatch || childMatch;
      for (const [key, item] of entries) if (timeKeys.has(key.toLowerCase()) && (typeof item === "string" || typeof item === "number")) results.push({ key: key.toLowerCase(), value: String(item), linked, depth });
      return linked;
    };
    document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"],script[type="application/json"]').forEach((script) => {
      const source = script.textContent ?? "";
      if (!source || source.length > 2_000_000) return;
      try { visit(JSON.parse(source), 0); }
      catch {
        const idPositions = [...source.matchAll(new RegExp(targetPostId, "g"))].map((match) => match.index ?? -100_000);
        const timePattern = /["']?(creation_time|publish_time|timestamp)["']?\s*[:=]\s*["']?([0-9]{9,13}|[0-9]{4}-[0-9]{2}-[0-9]{2}T[^"'\s,}]+)/gi;
        for (const match of source.matchAll(timePattern)) {
          const position = match.index ?? 100_000;
          results.push({ key: match[1].toLowerCase(), value: match[2], linked: idPositions.some((idPosition) => Math.abs(idPosition - position) <= 2_000), depth: 0 });
        }
      }
    });
    return results.filter((candidate) => candidate.linked).sort((left, right) => (left.key === "creation_time" ? 0 : 1) - (right.key === "creation_time" ? 0 : 1) || right.depth - left.depth);
  }, postId);
  for (const candidate of metadataCandidates) {
    const publishedAt = parseFacebookTimestampValue(candidate.value, nowMs);
    if (!publishedAt) continue;
    const timestamp = Date.parse(publishedAt);
    if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2010, 0, 1) || timestamp > nowMs + 5 * 60_000) continue;
    return { publishedAt, source: "POST_PAGE_METADATA" };
  }
  return { publishedAt: await detectFacebookPostPublishedAt(page, postId, nowMs), source: "POST_PAGE" };
}

export async function detectFacebookPostPublishedAt(page: Page, postId: string, nowMs = Date.now()): Promise<string | null> {
  const values = await page.evaluate((targetPostId) => {
    const postPath = new RegExp(`/groups/[^/]+/posts/${targetPostId}/?$`, "i");
    if (!postPath.test(location.pathname)) return [];
    const main = document.querySelector("main,[role=\"main\"]") ?? document.body;
    const candidates = Array.from(main.querySelectorAll<HTMLElement>('time[datetime],abbr[data-utime],a[aria-label],a[title]'))
      .filter((element) => {
        if (element.closest('form,[role="toolbar"],[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i]')) return false;
        const article = element.closest<HTMLElement>('[role="article"]');
        if (article && article.getBoundingClientRect().height < 220) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .sort((left, right) => {
        const leftMachine = left.hasAttribute("datetime") || left.hasAttribute("data-utime") ? 0 : 1;
        const rightMachine = right.hasAttribute("datetime") || right.hasAttribute("data-utime") ? 0 : 1;
        return leftMachine - rightMachine || left.getBoundingClientRect().top - right.getBoundingClientRect().top;
      })
      .slice(0, 30);
    const timestampValues: string[] = [];
    for (const candidate of candidates) {
      for (const value of [candidate.getAttribute("data-utime"), candidate.getAttribute("datetime"), candidate.getAttribute("aria-label"), candidate.getAttribute("title"), candidate.matches("time,abbr") ? candidate.textContent : null]) {
        const trimmed = value?.trim();
        if (trimmed && !timestampValues.includes(trimmed)) timestampValues.push(trimmed);
      }
    }
    return timestampValues;
  }, postId);
  return values.map((value) => parseFacebookTimestampValue(value, nowMs)).find((value): value is string => value !== null) ?? null;
}

export async function collectFacebookPostTimeDiagnostic(page: Page, postId: string, nowMs = Date.now()): Promise<FacebookPostTimeDiagnostic> {
  const raw = await page.evaluate((targetPostId) => {
    const main = document.querySelector("main,[role=\"main\"]") ?? document.body;
    const postPath = new RegExp(`/groups/[^/]+/posts/${targetPostId}/?$`, "i");
    const elements = new Set<HTMLElement>(Array.from(main.querySelectorAll<HTMLElement>('time,abbr,[datetime],[data-utime],[data-timestamp],[title],[aria-label]')));
    const postLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"][href*="/posts/"]')).filter((link) => { const url = new URL(link.href, location.href); return postPath.test(url.pathname) && !url.searchParams.has("comment_id"); });
    for (const link of postLinks) {
      let current: Element | null = link;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        if (current instanceof HTMLElement) elements.add(current);
        for (const sibling of [current.previousElementSibling, current.nextElementSibling]) if (sibling instanceof HTMLElement) elements.add(sibling);
        current.querySelectorAll<HTMLElement>('time,abbr,[datetime],[data-utime],[data-timestamp],[title],[aria-label]').forEach((element) => elements.add(element));
      }
    }
    const regionSignal = main.querySelector<HTMLElement>('[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-testid="post_message"],[data-testid="post-message"],img[data-visualcompletion="media-vc-image"],video');
    const regionElement = regionSignal?.closest<HTMLElement>('[role="article"],section,div') ?? regionSignal;
    const regionRect = regionElement?.getBoundingClientRect() ?? null;
    const candidates = [...elements].slice(0, 80).map((element) => {
      const rect = element.getBoundingClientRect();
      let nestingDepth: number | null = null;
      for (let depth = 0, current: Element | null = element; current && depth < 20; depth += 1, current = current.parentElement) if (current === main) { nestingDepth = depth; break; }
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        attributeNames: element.getAttributeNames().slice(0, 20),
        datetime: element.getAttribute("datetime"),
        dataUtime: element.getAttribute("data-utime"),
        dataTimestamp: element.getAttribute("data-timestamp"),
        ariaLabel: element.getAttribute("aria-label"),
        title: element.getAttribute("title"),
        nestingDepth,
        insideMain: main.contains(element),
        insideCommentRegion: Boolean(element.closest('[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i],form')) || Boolean(element.closest('[role="article"]') && element.closest<HTMLElement>('[role="article"]')!.getBoundingClientRect().height < 220),
        distanceToPostRegion: regionRect ? Math.round(Math.abs(rect.top - regionRect.top)) : null,
      };
    });
    const metadata: Array<{ metadataSource: string; timestampValue: string; linked: boolean }> = [];
    const addMetadata = (metadataSource: string, timestampValue: string | null, linked: boolean) => {
      const value = timestampValue?.trim();
      if (value && metadata.length < 20 && !metadata.some((item) => item.metadataSource === metadataSource && item.timestampValue === value)) metadata.push({ metadataSource, timestampValue: value, linked });
    };
    document.querySelectorAll<HTMLMetaElement>('meta[property="article:published_time"],meta[name="article:published_time"],meta[itemprop="datePublished"]').forEach((meta) => addMetadata("META", meta.content, postPath.test(location.pathname)));
    document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"],script[type="application/json"]').forEach((script, scriptIndex) => {
      const source = script.textContent ?? "";
      if (source.length > 2_000_000) return;
      const linked = source.includes(targetPostId);
      const pattern = /["']?(creation_time|publish_time|timestamp)["']?\s*[:=]\s*["']?([0-9]{9,13}|[0-9]{4}-[0-9]{2}-[0-9]{2}T[^"'\s,}]+)/gi;
      for (const match of source.matchAll(pattern)) addMetadata(`SCRIPT_${scriptIndex}:${match[1].toLowerCase()}`, match[2], linked);
    });
    return { finalPath: location.pathname, candidates, metadata };
  }, postId);
  const candidates = raw.candidates.map((candidate) => {
    const ariaParseable = parseFacebookTimestampValue(candidate.ariaLabel, nowMs) !== null;
    const titleParseable = parseFacebookTimestampValue(candidate.title, nowMs) !== null;
    const datetime = candidate.datetime && Number.isFinite(Date.parse(candidate.datetime)) ? candidate.datetime : null;
    const dataUtime = candidate.dataUtime && /^\d{9,13}$/.test(candidate.dataUtime) ? candidate.dataUtime : null;
    const dataTimestamp = candidate.dataTimestamp && /^\d{9,13}$/.test(candidate.dataTimestamp) ? candidate.dataTimestamp : null;
    const machineScore = datetime || dataUtime || dataTimestamp ? 100 : 0;
    return { tag: candidate.tag, role: candidate.role, attribute_names: candidate.attributeNames, datetime, data_utime: dataUtime, data_timestamp: dataTimestamp, aria_label_parseable_as_time: ariaParseable, title_parseable_as_time: titleParseable, nesting_depth: candidate.nestingDepth, inside_main: candidate.insideMain, inside_comment_region: candidate.insideCommentRegion, distance_to_post_region: candidate.distanceToPostRegion, candidate_score: machineScore + (ariaParseable ? 60 : 0) + (titleParseable ? 60 : 0) + (candidate.insideMain ? 10 : 0) - (candidate.insideCommentRegion ? 100 : 0) - Math.min(50, Math.round((candidate.distanceToPostRegion ?? 0) / 20)) };
  }).sort((left, right) => right.candidate_score - left.candidate_score).slice(0, 50);
  const metadata = raw.metadata.flatMap((item) => parseFacebookTimestampValue(item.timestampValue, nowMs) ? [{ metadata_source: item.metadataSource, timestamp_value: item.timestampValue, linked_to_expected_post_id: item.linked }] : []);
  return { post_id: postId, final_path: raw.finalPath, candidates, metadata };
}

export async function captureFacebookPostRegion(page: Page, postId: string, options: { mediaDiagnostic?: boolean } = {}): Promise<FacebookPostRegion> {
  const metadataResolution = await extractFacebookAuthoritativeTextFromMetadata(page, postId);
  const captureToken = `flip-${postId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const evaluated = await page.evaluate(({ targetPostId, captureToken: targetCaptureToken, collectMediaDiagnostic, allowStructuredExactPostBinding }) => {
    const postPath = new RegExp(`/groups/[^/]+/posts/${targetPostId}/?$`, "i");
    const dedicatedPageUrlMatches = postPath.test(location.pathname);
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"][href*="/posts/"]')).filter((link) => { const url = new URL(link.href, location.href); return postPath.test(url.pathname) && !url.searchParams.has("comment_id"); });
    const main = document.querySelector("main,[role=\"main\"]") ?? document.body;
    const mainRect = main.getBoundingClientRect();
    const commentRegionSelector = '[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i]';
    const headerSidebarSelector = 'nav,header,aside,[role="navigation"],[role="banner"],[role="complementary"]';
    const interactiveTextSelector = '[role="toolbar"],form,button,[role="button"]';
    const mediaUiExclusionSelector = '[role="toolbar"],form';
    const rectDistance = (left: DOMRect, right: DOMRect) => {
      const horizontal = Math.max(left.left - right.right, right.left - left.right, 0);
      const vertical = Math.max(left.top - right.bottom, right.top - left.bottom, 0);
      return Math.hypot(horizontal, vertical);
    };
    const postReferenceElements = [
      ...links,
      ...Array.from(main.querySelectorAll<HTMLElement>('[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-testid="post_message"],[data-testid="post-message"],div[dir="auto"],p,[data-lexical-text="true"]'))
        .filter((element) => !element.closest(`${commentRegionSelector},${headerSidebarSelector},${interactiveTextSelector}`)),
    ];
    const postReferenceRects = postReferenceElements.map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
    const possibleMedia = new Set<HTMLElement>(main.querySelectorAll<HTMLElement>('img,video,[role="img"]'));
    Array.from(main.querySelectorAll<HTMLElement>("*")).slice(0, 3_000).forEach((element) => {
      if (getComputedStyle(element).backgroundImage !== "none") possibleMedia.add(element);
    });
    const mediaFacts = Array.from(possibleMedia).map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      const insideComment = Boolean(element.closest(commentRegionSelector));
      const insideHeaderSidebar = Boolean(element.closest(headerSidebarSelector));
      // Facebook wraps gallery tiles in links/buttons that open the photo viewer.
      // Their dimensions and placement decide whether they are post media; the
      // wrapper alone must not classify them as reaction/control UI.
      const insideInteractiveUi = Boolean(element.closest(mediaUiExclusionSelector));
      const naturalWidth = element instanceof HTMLImageElement ? element.naturalWidth : element instanceof HTMLVideoElement ? element.videoWidth : element.querySelector<HTMLImageElement>("img")?.naturalWidth ?? 0;
      const naturalHeight = element instanceof HTMLImageElement ? element.naturalHeight : element instanceof HTMLVideoElement ? element.videoHeight : element.querySelector<HTMLImageElement>("img")?.naturalHeight ?? 0;
      const nearPostReference = postReferenceRects.some((reference) => rectDistance(rect, reference) <= 200);
      return { element, rect, visible, insideComment, insideHeaderSidebar, insideInteractiveUi, naturalWidth, naturalHeight, nearPostReference };
    });
    const qualifiedPostMedia = new Set(mediaFacts.filter((fact) => {
      const notIconSized = fact.rect.width > 48 && fact.rect.height > 48;
      const renderedCandidate = fact.rect.width >= 100 && fact.rect.height >= 100;
      const naturalCandidate = (fact.element instanceof HTMLImageElement || fact.element instanceof HTMLVideoElement) && Math.max(fact.naturalWidth, fact.naturalHeight) >= 300;
      const tileCandidate = fact.rect.width >= 90 && fact.rect.width <= 160 && fact.rect.height >= 90 && fact.rect.height <= 160 && fact.nearPostReference;
      const similarTileCount = tileCandidate ? mediaFacts.filter((other) => other.rect.width >= 90 && other.rect.width <= 160
        && other.rect.height >= 90 && other.rect.height <= 160
        && other.nearPostReference
        && Math.abs(other.rect.width - fact.rect.width) <= 30
        && Math.abs(other.rect.height - fact.rect.height) <= 30
        && rectDistance(other.rect, fact.rect) <= 800).length : 0;
      return fact.visible && !fact.insideComment && !fact.insideHeaderSidebar && !fact.insideInteractiveUi
        && notIconSized && (renderedCandidate || naturalCandidate || similarTileCount >= 2);
    }).map((fact) => fact.element));
    const dedupedPostMediaFacts = mediaFacts.filter((fact) => qualifiedPostMedia.has(fact.element)).reduce<typeof mediaFacts>((deduped, fact) => {
      const sameGeometry = deduped.some((existing) => Math.abs(existing.rect.left - fact.rect.left) <= 2
        && Math.abs(existing.rect.top - fact.rect.top) <= 2
        && Math.abs(existing.rect.width - fact.rect.width) <= 2
        && Math.abs(existing.rect.height - fact.rect.height) <= 2);
      if (!sameGeometry) deduped.push(fact);
      return deduped;
    }, []);
    const dedupedPostMedia = new Set(dedupedPostMediaFacts.map((fact) => fact.element));
    const mediaUnionBox = dedupedPostMediaFacts.length ? {
      left: Math.min(...dedupedPostMediaFacts.map((fact) => fact.rect.left)),
      top: Math.min(...dedupedPostMediaFacts.map((fact) => fact.rect.top)),
      right: Math.max(...dedupedPostMediaFacts.map((fact) => fact.rect.right)),
      bottom: Math.max(...dedupedPostMediaFacts.map((fact) => fact.rect.bottom)),
    } : null;
    const relatedTextSignal = mediaUnionBox ? postReferenceElements
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0 && rectDistance(rect, mediaUnionBox as DOMRect) <= 300)
      .sort((left, right) => rectDistance(left.rect, mediaUnionBox as DOMRect) - rectDistance(right.rect, mediaUnionBox as DOMRect))[0]?.element ?? null : null;
    const mediaAwareElements: Element[] = [...dedupedPostMedia, ...(relatedTextSignal ? [relatedTextSignal] : [])];
    const findLowestCommonAncestor = (elements: Element[], boundary: Element): Element | null => {
      if (!elements.length) return null;
      let current: Element | null = elements[0].parentElement;
      while (current) {
        if (elements.every((element) => current?.contains(element))) return current;
        if (current === boundary) break;
        current = current.parentElement;
      }
      return null;
    };
    const mediaAwareAncestor = findLowestCommonAncestor(mediaAwareElements, main);
    const roots: Element[] = [];
    const nestingDepths = new Map<Element, number>();
    const addAncestors = (element: Element, boundary: Element | null, maxDepth: number) => {
      let current: Element | null = element;
      for (let depth = 0; current && depth < maxDepth; depth += 1, current = current.parentElement) {
        if (!roots.includes(current)) roots.push(current);
        nestingDepths.set(current, Math.min(nestingDepths.get(current) ?? depth, depth));
        if (current === boundary) break;
      }
    };
    if (dedicatedPageUrlMatches) {
      for (const link of links) addAncestors(link, null, 12);
      const contentSignals = [
        ...Array.from(main.querySelectorAll<HTMLElement>('[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-testid="post_message"],[data-testid="post-message"],div[dir="auto"],p,[data-lexical-text="true"]')),
        ...dedupedPostMedia,
      ].slice(0, 120);
      for (const signal of contentSignals) addAncestors(signal, main, 7);
      if (mediaAwareAncestor) addAncestors(mediaAwareAncestor, main, 12);
    }
    // A dedicated page can still render neighbouring feed stories.  Select one
    // structural root bound to the requested canonical permalink before any
    // text, time or media candidate is considered.
    const postIdsIn = (element: Element) => Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"][href*="/posts/"]'))
      .concat(element instanceof HTMLAnchorElement ? [element] : [])
      .flatMap((link) => new URL(link.href, location.href).pathname.match(/\/posts\/(\d+)/i)?.[1] ?? []);
    const storyRootForLink = (link: HTMLAnchorElement): Element | null => {
      let current: Element | null = link;
      let selected: Element | null = null;
      while (current && current !== main) {
        const ids = [...new Set(postIdsIn(current))];
        if (ids.some((id) => id !== targetPostId)) break;
        if (ids.length === 1 && ids[0] === targetPostId) selected = current;
        current = current.parentElement;
      }
      return selected;
    };
    const exactStoryRoots = [...new Set(links.map(storyRootForLink).filter((root): root is Element => root !== null))];
    // More than one disjoint root for the exact canonical permalink is an
    // ambiguity: do not merge data from either root.
    // On canonical post pages Facebook may omit the permalink anchor from the
    // rendered story. In that layout the already-qualified media ancestor is
    // the only safe root signal available. Accept it only when it contains no
    // foreign post permalink; never fall back to the feed/main wrapper.
    const targetLink = links.find((link) => {
      const path = new URL(link.href, location.href).pathname;
      return postPath.test(path) && !new URL(link.href, location.href).searchParams.has("comment_id");
    }) ?? null;
    const targetLinkAncestor = targetLink ? (() => {
      let current: Element | null = targetLink;
      let selected: Element | null = null;
      while (current && current !== main) {
        if (postIdsIn(current).includes(targetPostId)) selected = current;
        current = current.parentElement;
      }
      return selected;
    })() : null;
    let structuredNarrowRoot: Element | null = null;
    if (exactStoryRoots.length === 0 && allowStructuredExactPostBinding) {
      const messageSignals = Array.from(main.querySelectorAll<HTMLElement>('[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-testid="post_message"],[data-testid="post-message"]'))
        .filter((element) => !element.closest(`${commentRegionSelector},${headerSidebarSelector},${interactiveTextSelector}`));
      for (const signal of messageSignals) {
        let current: Element | null = signal;
        for (let depth = 0; current && depth < 8 && current !== main; depth += 1, current = current.parentElement) {
          const ancestor = current;
          const rect = ancestor.getBoundingClientRect();
          if (rect.width < 280 || rect.width > 1_600 || rect.height < 100 || rect.height > 1_600) continue;
          const foreignIds = postIdsIn(ancestor).filter((id) => id !== targetPostId);
          const localMedia = [...dedupedPostMedia].filter((media) => ancestor.contains(media));
          if (foreignIds.length === 0 && localMedia.length > 0) {
            structuredNarrowRoot = ancestor;
            break;
          }
        }
        if (structuredNarrowRoot) break;
      }
    }
    const canonicalMediaRoot = dedicatedPageUrlMatches
      ? (mediaAwareAncestor && mediaAwareAncestor !== main ? mediaAwareAncestor : targetLinkAncestor)
      : null;
    roots.splice(0, roots.length, ...(exactStoryRoots.length === 1
      ? [exactStoryRoots[0]]
      : exactStoryRoots.length === 0 && (structuredNarrowRoot || canonicalMediaRoot) && (structuredNarrowRoot || canonicalMediaRoot) !== main
        ? [structuredNarrowRoot || canonicalMediaRoot!]
        : []));
    let candidatesAfterSizeFilter = 0;
    let candidatesAfterContentFilter = 0;
    let candidatesAfterCommentFilter = 0;
    let candidatesAfterVisibilityFilter = 0;
    let validBoundingBoxCount = 0;
    const candidateDiagnostics: Array<Record<string, unknown>> = [];
    const candidates = roots.flatMap((root, rootIndex) => {
      const rect = root.getBoundingClientRect();
      const style = getComputedStyle(root);
      const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      const descendantPostLinks = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"][href*="/posts/"]'));
      const rootPostLink = root instanceof HTMLAnchorElement && root.matches('a[href*="/groups/"][href*="/posts/"]') ? [root] : [];
      const containsPostPermalink = [...rootPostLink, ...descendantPostLinks].some((link) => { const url = new URL(link.href, location.href); return postPath.test(url.pathname) && !url.searchParams.has("comment_id"); });
      const containsCommentSection = root.matches('[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i]') || Boolean(root.querySelector('[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i],[role="article"] [role="article"]'));
      const containsToolbar = root.matches('[role="toolbar"]') || Boolean(root.querySelector('[role="toolbar"]'));
      const containsForm = root.matches("form") || Boolean(root.querySelector("form"));
      const excludedContainer = root.matches('nav,header,aside,[role="navigation"],[role="banner"],[role="complementary"],form,[role="toolbar"]') || Boolean(root.closest('nav,header,aside,[role="navigation"],[role="banner"],[role="complementary"]'));
      const canonicalSizeAccepted = dedicatedPageUrlMatches && root === canonicalMediaRoot
        && rect.width >= 280 && rect.width <= 1_600 && rect.height > 0;
      const sizeAccepted = canonicalSizeAccepted || (rect.width >= 280 && rect.width <= 1_200 && rect.height >= 100 && rect.height <= 1_600);
      const rawTextNodes = Array.from(root.querySelectorAll<HTMLElement>('[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-testid="post_message"],[data-testid="post-message"],div[dir="auto"],p,[data-lexical-text="true"]'));
      const rawMedia = Array.from(dedupedPostMedia).filter(
        (element) => element !== root && root.contains(element),
      );
      if (sizeAccepted && rawTextNodes.length + rawMedia.length > 0) candidatesAfterContentFilter += 1;
      const excludedAsComment = (element: Element) => {
        if (element.closest('[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i]')) return true;
        const nestedArticle = element.closest('[role="article"]');
        if (nestedArticle && nestedArticle !== root && nestedArticle.getBoundingClientRect().height < 220) return true;
        return false;
      };
      const excluded = (element: Element) => excludedAsComment(element) || Boolean(element.closest('button,[role="button"],[role="toolbar"],form'));
      const excludedMedia = (element: Element) => excludedAsComment(element) || Boolean(element.closest('[role="toolbar"],form'));
      const commentFilteredNodes = [...rawTextNodes, ...rawMedia].filter((element) => !excludedAsComment(element));
      const textNodes = rawTextNodes
        .filter((element) => !excluded(element) && element.innerText.trim().length >= 12 && !element.querySelector('a,button,[role="button"],[role="toolbar"]'));
      const media = rawMedia
        .filter((element) => {
          if (excludedMedia(element) || element.closest('nav,header,aside,[role="navigation"],[role="banner"],[role="complementary"]')) return false;
          return true;
        });
      const visualNodes = [...textNodes, ...media];
      const boxes = visualNodes.map((element) => element.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
      const contentLength = textNodes.reduce((total, element) => total + Math.min(element.innerText.trim().length, 2_000), 0);
      const topPreference = Math.max(0, 200 - Math.max(0, rect.top - mainRect.top) / 4);
      const score = contentLength + media.length * 250 - Math.max(0, visualNodes.length - 20) * 20 + topPreference;
      const rejectionReasons: string[] = [];
      if (rect.width < 280 || rect.height < 100) rejectionReasons.push("TOO_SMALL");
      if (rect.width > 1_200 || rect.height > 1_600) rejectionReasons.push("TOO_LARGE");
      if (!visible) rejectionReasons.push("NOT_VISIBLE");
      if (!containsPostPermalink && !dedicatedPageUrlMatches) rejectionReasons.push("NO_POST_SIGNAL");
      if (rawTextNodes.length + rawMedia.length === 0 || visualNodes.length === 0) rejectionReasons.push("NO_TEXT_OR_MEDIA");
      if (rawTextNodes.length + rawMedia.length > 0 && commentFilteredNodes.length === 0) rejectionReasons.push("COMMENT_REGION");
      if (containsToolbar && visualNodes.length === 0) rejectionReasons.push("TOOLBAR_REGION");
      if (excludedContainer) rejectionReasons.push(root.matches('form,[role="toolbar"]') ? "TOOLBAR_REGION" : "NO_POST_SIGNAL");
      if (sizeAccepted) candidatesAfterSizeFilter += 1;
      if (sizeAccepted && !containsCommentSection && commentFilteredNodes.length > 0) candidatesAfterCommentFilter += 1;
      if (sizeAccepted && !excludedContainer && visible && visualNodes.length > 0) candidatesAfterVisibilityFilter += 1;
      if (sizeAccepted && !excludedContainer && visualNodes.length > 0 && boxes.length > 0) validBoundingBoxCount += 1;
      if (sizeAccepted && !excludedContainer && visualNodes.length > 0 && boxes.length === 0) rejectionReasons.push("INVALID_BOUNDING_BOX");
      candidateDiagnostics.push({
        index: rootIndex,
        tag: root.tagName.toLowerCase(),
        role: root.getAttribute("role"),
        nesting_depth: nestingDepths.get(root) ?? null,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        area: Math.round(rect.width * rect.height),
        visible,
        text_node_count: textNodes.length,
        media_count: media.length,
        img_count: root.querySelectorAll("img").length,
        video_count: root.querySelectorAll("video").length,
        link_count: root.querySelectorAll("a").length,
        contains_post_permalink: containsPostPermalink,
        contains_comment_section: containsCommentSection,
        contains_toolbar: containsToolbar,
        contains_form: containsForm,
        score,
        rejection_reasons: rejectionReasons,
      });
      if (!sizeAccepted || excludedContainer || !visualNodes.length || !boxes.length) return [];
      const candidateBox = {
        x: Math.max(0, rect.left + window.scrollX),
        y: Math.max(0, rect.top + window.scrollY),
        width: Math.min(rect.width, document.documentElement.scrollWidth - Math.max(0, rect.left + window.scrollX)),
        height: Math.min(rect.height, document.documentElement.scrollHeight - Math.max(0, rect.top + window.scrollY)),
      };
      const mediaBoxes = media.map((element) => element.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
      const mediaBox = mediaBoxes.length ? {
        x: Math.min(...mediaBoxes.map((box) => box.left + window.scrollX)),
        y: Math.min(...mediaBoxes.map((box) => box.top + window.scrollY)),
        width: Math.max(...mediaBoxes.map((box) => box.right + window.scrollX)) - Math.min(...mediaBoxes.map((box) => box.left + window.scrollX)),
        height: Math.max(...mediaBoxes.map((box) => box.bottom + window.scrollY)) - Math.min(...mediaBoxes.map((box) => box.top + window.scrollY)),
      } : null;
      const commentTops = Array.from(root.querySelectorAll<HTMLElement>('[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i],[role="article"]'))
        .filter((element) => element.matches('[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i]') || element.getBoundingClientRect().height < 220)
        .map((element) => element.getBoundingClientRect().top + window.scrollY)
        .filter((top) => top > candidateBox.y);
      const commentBoundaryY = commentTops.length ? Math.min(...commentTops) : null;
      const mediaBottom = mediaBox ? mediaBox.y + mediaBox.height : null;
      const contentBottom = Math.max(...boxes.map((box) => box.bottom + window.scrollY));
      const safeCommentBoundary = commentBoundaryY !== null && commentBoundaryY >= Math.max(contentBottom, mediaBottom ?? contentBottom) - 1 ? commentBoundaryY : null;
      const candidateBottom = candidateBox.y + candidateBox.height;
      const finalBottom = safeCommentBoundary !== null ? Math.min(candidateBottom, safeCommentBoundary) : candidateBottom;
      const cropReasons: string[] = [];
      if (safeCommentBoundary !== null && safeCommentBoundary < candidateBottom) cropReasons.push("COMMENT_BOUNDARY_APPLIED");
      if (commentBoundaryY !== null && safeCommentBoundary === null && mediaBottom !== null && commentBoundaryY < mediaBottom) cropReasons.push("COMMENT_BOUNDARY_INTERSECTS_MEDIA_IGNORED");
      if (candidateBox.height < rect.height || candidateBox.width < rect.width) cropReasons.push("DOCUMENT_BOUNDS_CLAMPED");
      const box = { x: candidateBox.x, y: candidateBox.y, width: candidateBox.width, height: finalBottom - candidateBox.y };
      const postIdsInRoot = [...rootPostLink, ...descendantPostLinks].flatMap((link) => {
        const match = new URL(link.href, location.href).pathname.match(/\/posts\/(\d+)/i);
        return match?.[1] ? [match[1]] : [];
      });
      const foreignPostIdsDetected = [...new Set(postIdsInRoot.filter((id) => id !== targetPostId))];
      const rootStoryUnique = dedicatedPageUrlMatches && foreignPostIdsDetected.length === 0;
      const mediaCandidates = media.flatMap((element) => {
        const imageElement = element instanceof HTMLImageElement ? element : element.querySelector<HTMLImageElement>("img[src]");
        const url = imageElement?.src;
        if (!url) return [];
        const intrinsicWidth = imageElement?.naturalWidth || Math.round(element.getBoundingClientRect().width) || null;
        const intrinsicHeight = imageElement?.naturalHeight || Math.round(element.getBoundingClientRect().height) || null;
        // Small near-square assets are overwhelmingly avatars/profile tiles or UI chrome.
        // Reject them before they enter the post media candidate set.
        if (intrinsicWidth && intrinsicHeight && intrinsicWidth <= 200 && intrinsicHeight <= 200) {
          const ratio = intrinsicWidth / intrinsicHeight;
          if (ratio >= 0.8 && ratio <= 1.25) return [];
        }
        let identityRoot: Element | null = element;
        let boundIds: string[] = [];
        while (identityRoot && main.contains(identityRoot)) {
          boundIds = Array.from(identityRoot.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"][href*="/posts/"]')).flatMap((link) => {
            const match = new URL(link.href, location.href).pathname.match(/\/posts\/(\d+)/i);
            return match?.[1] ? [match[1]] : [];
          });
          if (boundIds.length > 0) break;
          if (identityRoot === root || identityRoot === main) break;
          identityRoot = identityRoot.parentElement;
        }
        const uniqueBoundIds = [...new Set(boundIds)];
        const mediaForeignIds = uniqueBoundIds.filter((id) => id !== targetPostId);
        const exactRootBinding = uniqueBoundIds.length === 1 && uniqueBoundIds[0] === targetPostId;
        // Dedicated-page fallback is allowed only for the selected candidate
        // subtree itself. A generic ancestor/viewer must never lend its media
        // to the requested post merely because it contains no permalink IDs.
        const structuredPostMediaBinding = allowStructuredExactPostBinding && root === structuredNarrowRoot && uniqueBoundIds.length === 0 && rootStoryUnique;
        const unambiguousViewerBinding = uniqueBoundIds.length === 0 && rootStoryUnique && identityRoot === root && !structuredPostMediaBinding;
        const bindingProvenance = exactRootBinding ? "EXACT_ROOT_STORY" : structuredPostMediaBinding ? "EXACT_POST_METADATA" : unambiguousViewerBinding ? "DEDICATED_POST_VIEWER" : "AMBIGUOUS";
        return [{
          url,
          expectedPostId: targetPostId,
          storyRootPostId: rootStoryUnique ? targetPostId : null,
          boundPostId: exactRootBinding || structuredPostMediaBinding || unambiguousViewerBinding ? targetPostId : null,
          bindingConfidence: exactRootBinding ? 1 : structuredPostMediaBinding || unambiguousViewerBinding ? 0.95 : 0,
          bindingProvenance,
          rootStoryUnique: exactRootBinding || structuredPostMediaBinding || unambiguousViewerBinding,
          foreignPostIdsDetected: mediaForeignIds,
          classification: "UNKNOWN",
          classificationConfidence: null,
          intrinsicWidth,
          intrinsicHeight,
          structuredPostMediaProvenance: structuredPostMediaBinding,
        }];
      }).filter((candidate, index, all) => all.findIndex((item) => item.url === candidate.url) === index);
      const imageUrls = mediaCandidates.filter((candidate) => candidate.storyRootPostId === targetPostId && candidate.boundPostId === targetPostId && candidate.rootStoryUnique).map((candidate) => candidate.url);
      const time = root.querySelector<HTMLTimeElement>("time[datetime]")?.dateTime ?? null;
      return [{
        rootIndex,
        score,
        area: rect.width * rect.height,
        visible,
        validBoundingBox: boxes.length > 0 && (canonicalSizeAccepted
          || (rect.width >= 120 && rect.height >= 40 && rect.height <= 1_200)),
        hasContent: visualNodes.length > 0,
        containsCommentSection,
        containsToolbar,
        containsForm,
        mediaCount: media.length,
        textNodeCount: textNodes.length,
        nestingDepth: nestingDepths.get(root) ?? null,
        box,
        imageUrls,
        mediaCandidates,
        publishedAt: time,
        screenshotDiagnostic: {
          candidate_box: candidateBox,
          media_box: mediaBox,
          comment_boundary_y: commentBoundaryY,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          scroll_y: window.scrollY,
          final_clip: box,
          crop_reasons: cropReasons,
        },
      }];
    });
    // This callback runs in the page context, so keep the browser-side ranking
    // self-contained instead of closing over the exported Node test helper.
    const mediaAwareRootIndex = mediaAwareAncestor ? roots.indexOf(mediaAwareAncestor) : -1;
    const mediaAwareCandidate = mediaAwareRootIndex >= 0 ? candidates.find((candidate) => candidate.rootIndex === mediaAwareRootIndex) ?? null : null;
    const mediaAwareCommentBoundary = mediaAwareCandidate?.screenshotDiagnostic.comment_boundary_y ?? null;
    const mediaAwareMediaBox = mediaAwareCandidate?.screenshotDiagnostic.media_box ?? null;
    const mediaAboveCommentBoundary = mediaAwareCommentBoundary === null || (mediaAwareMediaBox !== null
      && mediaAwareMediaBox.y + mediaAwareMediaBox.height <= mediaAwareCommentBoundary + 1);
    const mediaAwareRejectionReason = qualifiedPostMedia.size === 0 ? "NO_QUALIFIED_MEDIA"
      : dedupedPostMedia.size === 0 ? "NO_DEDUPED_MEDIA"
        : !mediaAwareAncestor ? "COMMON_ANCESTOR_NOT_FOUND"
          : !mediaAwareCandidate ? "ANCESTOR_CANDIDATE_REJECTED"
            : !mediaAwareCandidate.validBoundingBox ? "INVALID_CANDIDATE_BOX"
              : mediaAwareCandidate.mediaCount === 0 ? "QUALIFIED_MEDIA_NOT_IN_CANDIDATE"
                : null;
    const mediaAwareBuildDiagnostic = {
      qualified_media_count: qualifiedPostMedia.size,
      deduped_media_count: dedupedPostMedia.size,
      common_ancestor_found: mediaAwareAncestor !== null,
      ancestor_contains_comments: mediaAwareCandidate?.containsCommentSection ?? (mediaAwareAncestor ? Boolean(mediaAwareAncestor.querySelector(commentRegionSelector)) : false),
      comment_boundary_found: mediaAwareCommentBoundary !== null,
      media_above_comment_boundary: mediaAboveCommentBoundary,
      candidate_box_valid: mediaAwareCandidate?.validBoundingBox ?? false,
      rejection_reason: mediaAwareRejectionReason,
    };
    const fallbackCandidates = candidates.filter((candidate) => candidate.visible
      && candidate.validBoundingBox
      && candidate.hasContent);
    const cleanCandidates = fallbackCandidates.filter((candidate) => candidate.visible
      && candidate.validBoundingBox
      && candidate.hasContent
      && !candidate.containsCommentSection
      && !candidate.containsToolbar
      && !candidate.containsForm);
    const cleanPoolUsed = cleanCandidates.length > 0;
    const mediaFallbackCandidates = cleanPoolUsed || mediaAwareRejectionReason !== null || !mediaAwareCandidate ? [] : [mediaAwareCandidate];
    const mediaFallbackUsed = mediaFallbackCandidates.length > 0;
    const selectionStrategy = cleanPoolUsed ? "CLEAN" : mediaFallbackUsed ? "MEDIA_AWARE" : "GENERAL_FALLBACK";
    const selectionPool = [...(cleanPoolUsed ? cleanCandidates : mediaFallbackUsed ? mediaFallbackCandidates : fallbackCandidates)].sort((left, right) => {
      if (cleanPoolUsed) {
        return right.mediaCount - left.mediaCount
          || right.textNodeCount - left.textNodeCount
          || right.score - left.score
          || (left.nestingDepth ?? Number.MAX_SAFE_INTEGER) - (right.nestingDepth ?? Number.MAX_SAFE_INTEGER)
          || left.area - right.area;
      }
      if (mediaFallbackUsed) {
        const leftDirtySignals = Number(left.containsCommentSection) + Number(left.containsToolbar) + Number(left.containsForm);
        const rightDirtySignals = Number(right.containsCommentSection) + Number(right.containsToolbar) + Number(right.containsForm);
        return right.mediaCount - left.mediaCount
          || Number(right.textNodeCount > 0) - Number(left.textNodeCount > 0)
          || leftDirtySignals - rightDirtySignals
          || (left.nestingDepth ?? Number.MAX_SAFE_INTEGER) - (right.nestingDepth ?? Number.MAX_SAFE_INTEGER)
          || left.area - right.area
          || right.score - left.score;
      }
      return right.score - left.score || left.area - right.area;
    });
    const firstCandidate = selectionPool[0];
    const secondCandidate = selectionPool[1];
    const ambiguousCleanCandidates = Boolean(firstCandidate && secondCandidate
      && firstCandidate.mediaCount === secondCandidate.mediaCount
      && firstCandidate.textNodeCount === secondCandidate.textNodeCount
      && Math.abs(firstCandidate.score - secondCandidate.score) < 0.001
      && firstCandidate.nestingDepth === secondCandidate.nestingDepth
      && Math.abs(firstCandidate.area - secondCandidate.area) < 100);
    if (cleanPoolUsed) {
      for (const candidate of candidates.filter((item) => item.containsCommentSection || item.containsToolbar || item.containsForm)) {
        const diagnostic = candidateDiagnostics.find((item) => item.index === candidate.rootIndex);
        if (!diagnostic) continue;
        const rejectionReasons = diagnostic.rejection_reasons as string[];
        if (candidate.containsCommentSection && !rejectionReasons.includes("COMMENT_REGION")) rejectionReasons.push("COMMENT_REGION");
        if (candidate.containsToolbar && !rejectionReasons.includes("TOOLBAR_REGION")) rejectionReasons.push("TOOLBAR_REGION");
        if (candidate.containsForm && !rejectionReasons.includes("FORM_REGION")) rejectionReasons.push("FORM_REGION");
      }
    }
    const invalidTopBoundingBox = Boolean(selectionPool[0] && !selectionPool[0].validBoundingBox);
    if (invalidTopBoundingBox) {
      validBoundingBoxCount = 0;
      const diagnostic = candidateDiagnostics.find((candidate) => candidate.index === selectionPool[0].rootIndex);
      if (diagnostic) (diagnostic.rejection_reasons as string[]).push("INVALID_BOUNDING_BOX");
    }
    const ambiguousTopCandidates = ambiguousCleanCandidates;
    if (ambiguousTopCandidates) {
      for (const candidate of selectionPool.slice(0, 2)) {
        const diagnostic = candidateDiagnostics.find((item) => item.index === candidate.rootIndex);
        if (diagnostic) (diagnostic.rejection_reasons as string[]).push("AMBIGUOUS_SCORE");
      }
    }
    const selected = selectionPool.length && !invalidTopBoundingBox && !ambiguousTopCandidates ? selectionPool[0] : null;
    const selectedRoot = selected ? roots[selected.rootIndex] : null;
    const selectedRect = selectedRoot?.getBoundingClientRect() ?? null;
    const mediaDiagnostic = collectMediaDiagnostic ? (() => {
      type DiagnosticSourceType = "IMG" | "PICTURE" | "ROLE_IMG" | "VIDEO" | "POSTER" | "BACKGROUND";
      const found: Array<{ element: HTMLElement; sourceType: DiagnosticSourceType }> = [];
      const seen = new WeakMap<HTMLElement, Set<DiagnosticSourceType>>();
      const add = (element: HTMLElement, sourceType: DiagnosticSourceType) => {
        const types = seen.get(element) ?? new Set<DiagnosticSourceType>();
        if (types.has(sourceType)) return;
        types.add(sourceType); seen.set(element, types); found.push({ element, sourceType });
      };
      document.querySelectorAll<HTMLImageElement>("img").forEach((element) => add(element, element.closest("picture") ? "PICTURE" : "IMG"));
      document.querySelectorAll<HTMLElement>('[role="img"]').forEach((element) => { if (!(element instanceof HTMLImageElement)) add(element, "ROLE_IMG"); });
      document.querySelectorAll<HTMLVideoElement>("video").forEach((element) => { add(element, "VIDEO"); if (element.hasAttribute("poster")) add(element, "POSTER"); });
      Array.from(document.querySelectorAll<HTMLElement>("body *")).slice(0, 3_000).forEach((element) => {
        if (getComputedStyle(element).backgroundImage !== "none") add(element, "BACKGROUND");
      });
      const mainRoot = document.querySelector("main,[role=\"main\"]");
      const commentSelector = '[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i]';
      const headerSidebarSelector = 'nav,header,aside,[role="navigation"],[role="banner"],[role="complementary"]';
      const distanceToSelected = (rect: DOMRect) => {
        if (!selectedRect) return null;
        const horizontal = Math.max(selectedRect.left - rect.right, rect.left - selectedRect.right, 0);
        const vertical = Math.max(selectedRect.top - rect.bottom, rect.top - selectedRect.bottom, 0);
        return Math.round(Math.hypot(horizontal, vertical));
      };
      const ancestorDepth = (element: HTMLElement) => {
        if (!selectedRoot || !selectedRoot.contains(element)) return null;
        let depth = 0; let current: Element | null = element;
        while (current && current !== selectedRoot) { depth += 1; current = current.parentElement; }
        return current === selectedRoot ? depth : null;
      };
      const candidates = found.map(({ element, sourceType }) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        const insideMain = Boolean(mainRoot?.contains(element));
        const insideCommentRegion = Boolean(element.closest(commentSelector));
        const insideHeaderSidebar = Boolean(element.closest(headerSidebarSelector));
        const postMediaCandidate = qualifiedPostMedia.has(element);
        const exclusionReason = !visible ? "NOT_VISIBLE"
          : insideCommentRegion ? "COMMENT_REGION"
            : insideHeaderSidebar ? "HEADER_SIDEBAR"
              : !insideMain ? "OUTSIDE_MAIN"
                : !postMediaCandidate ? "TOO_SMALL"
                  : null;
        const naturalWidth = element instanceof HTMLImageElement ? element.naturalWidth : element instanceof HTMLVideoElement ? element.videoWidth : null;
        const naturalHeight = element instanceof HTMLImageElement ? element.naturalHeight : element instanceof HTMLVideoElement ? element.videoHeight : null;
        return {
          tag: element.tagName.toLowerCase(), source_type: sourceType, width: Math.round(rect.width), height: Math.round(rect.height),
          natural_width: naturalWidth, natural_height: naturalHeight, visible, inside_main: insideMain,
          inside_comment_region: insideCommentRegion, inside_header_sidebar: insideHeaderSidebar,
          distance_to_selected_region: distanceToSelected(rect), ancestor_depth_to_selected_region: ancestorDepth(element),
          excluded_by_rule: exclusionReason !== null, exclusion_reason: exclusionReason,
        };
      });
      const typeCounts = candidates.reduce<Record<string, number>>((counts, candidate) => { counts[candidate.source_type] = (counts[candidate.source_type] ?? 0) + 1; return counts; }, {});
      return {
        post_id: targetPostId,
        candidates,
        summary: {
          total_media_candidates: candidates.length,
          large_visible_candidates: candidates.filter((candidate) => candidate.visible && !candidate.excluded_by_rule).length,
          excluded_candidates: candidates.filter((candidate) => candidate.excluded_by_rule).length,
          candidates_inside_comments: candidates.filter((candidate) => candidate.inside_comment_region).length,
          candidates_inside_main: candidates.filter((candidate) => candidate.inside_main).length,
          candidate_types: typeCounts,
        },
      };
    })() : null;
    document.querySelectorAll("[data-flip-facebook-capture]").forEach((element) => element.removeAttribute("data-flip-facebook-capture"));
    if (selected) roots[selected.rootIndex]?.setAttribute("data-flip-facebook-capture", targetCaptureToken);
    return {
      region: selected ? {
        score: selected.score,
        area: selected.area,
        box: selected.box,
        imageUrls: selected.imageUrls,
        mediaCandidates: selected.mediaCandidates,
        publishedAt: selected.publishedAt,
        candidateCount: candidates.length,
        cleanPoolUsed,
        mediaFallbackUsed,
        mediaCandidateCount: mediaFallbackCandidates.length,
        cleanCandidateCount: cleanCandidates.length,
        qualifiedMediaCount: qualifiedPostMedia.size,
        fallbackCandidateCount: fallbackCandidates.length,
        selectionStrategy,
        selectedMediaCount: selected.mediaCount,
        containsCommentSection: selected.containsCommentSection,
        containsToolbar: selected.containsToolbar,
        containsForm: selected.containsForm,
        screenshotDiagnostic: selected.screenshotDiagnostic,
      } : null,
      diagnostic: {
        post_id: targetPostId,
        final_path: location.pathname,
        dedicated_page_url_matches: dedicatedPageUrlMatches,
        canonical_post_anchor_found: links.length > 0,
        canonical_anchor_count: links.length,
        candidate_ancestor_count: roots.length,
        candidates_after_size_filter: candidatesAfterSizeFilter,
        candidates_after_content_filter: candidatesAfterContentFilter,
        candidates_after_comment_filter: candidatesAfterCommentFilter,
        candidates_after_visibility_filter: candidatesAfterVisibilityFilter,
        valid_bounding_box_count: validBoundingBoxCount,
        ambiguous_top_candidates: ambiguousTopCandidates,
        selected_candidate_index: selected?.rootIndex ?? null,
        candidates: candidateDiagnostics.slice(0, 10),
      },
      mediaAwareBuildDiagnostic,
      mediaDiagnostic,
    };
  }, { targetPostId: postId, captureToken, collectMediaDiagnostic: options.mediaDiagnostic === true, allowStructuredExactPostBinding: metadataResolution.rootStoryIdentified && metadataResolution.rootAuthorMessageIdentified });
  const counts: FacebookPostRegionDiagnosticCounts = {
    dedicatedPageUrlMatches: evaluated.diagnostic.dedicated_page_url_matches,
    canonicalAnchorCount: evaluated.diagnostic.canonical_anchor_count,
    candidateAncestorCount: evaluated.diagnostic.candidate_ancestor_count,
    candidatesAfterSizeFilter: evaluated.diagnostic.candidates_after_size_filter,
    candidatesAfterContentFilter: evaluated.diagnostic.candidates_after_content_filter,
    candidatesAfterCommentFilter: evaluated.diagnostic.candidates_after_comment_filter,
    candidatesAfterVisibilityFilter: evaluated.diagnostic.candidates_after_visibility_filter,
    validBoundingBoxCount: evaluated.diagnostic.valid_bounding_box_count,
    ambiguousTopCandidates: evaluated.diagnostic.ambiguous_top_candidates,
  };
  const regionFailureReason = evaluated.region ? null : determineFacebookPostRegionFailureReason(counts);
  logFacebookWorker("FACEBOOK_POST_REGION_DIAGNOSTIC", { ...evaluated.diagnostic, region_failure_reason: regionFailureReason });
  logFacebookWorker("FACEBOOK_MEDIA_AWARE_BUILD_DIAGNOSTIC", {
    post_id: postId,
    ...evaluated.mediaAwareBuildDiagnostic,
  });
  if (evaluated.mediaDiagnostic) logFacebookWorker("FACEBOOK_MEDIA_DISCOVERY_DIAGNOSTIC", evaluated.mediaDiagnostic);
  const region = evaluated.region;
  if (!region) throw new Error("FACEBOOK_POST_REGION_NOT_FOUND");
  logFacebookWorker("FACEBOOK_POST_SELECTION_STRATEGY", {
    post_id: postId,
    clean_candidate_count: region.cleanCandidateCount,
    qualified_media_count: region.qualifiedMediaCount,
    fallback_candidate_count: region.fallbackCandidateCount,
    strategy: region.selectionStrategy,
  });
  const selectedLocator = page.locator(`[data-flip-facebook-capture="${captureToken}"]`);
  const selectedElementBox = await selectedLocator.boundingBox().catch(() => null);
  const domLayers = await extractFacebookPostTextLayersFromDom(page, captureToken, postId, region.screenshotDiagnostic.comment_boundary_y);
  const sharedContentDetected = metadataResolution.sharedContentDetected || domLayers.sharedContentDetected;
  const authoritativeResolution = resolveFacebookAuthoritativeTextSources(metadataResolution.outerText, domLayers.outerText, metadataResolution.sharedText, domLayers.sharedText, {
    sharedContentDetected,
    metadataRootAuthorIdentified: metadataResolution.rootAuthorMessageIdentified,
    domRootAuthorIdentified: domLayers.rootAuthorMessageIdentified,
    rootStoryIdentified: metadataResolution.rootStoryIdentified || domLayers.rootStoryIdentified,
  });
  const authoritativePostText = authoritativeResolution.text;
  const authoritativePostTextSource = authoritativeResolution.source;
  const authoritativePostTextProvenance = authoritativeResolution.provenance;
  const outerDiagnosticText = metadataResolution.outerText || domLayers.outerText;
  const sharedDiagnosticText = metadataResolution.sharedText || domLayers.sharedText;
  const attachmentDiagnosticText = metadataResolution.attachmentText || domLayers.attachmentText || metadataResolution.mediaText || domLayers.mediaText;
  const outerSignals = inspectFacebookIntentSignals(outerDiagnosticText);
  const sharedSignals = inspectFacebookIntentSignals(sharedDiagnosticText);
  const attachmentSignals = inspectFacebookIntentSignals(attachmentDiagnosticText);
  logFacebookWorker("FACEBOOK_POST_TEXT_LAYER_DIAGNOSTIC", {
    post_id: postId,
    outer_text_length: outerDiagnosticText.length,
    outer_buy_signals: outerSignals.buySignals,
    outer_sell_signals: outerSignals.sellSignals,
    shared_text_length: sharedDiagnosticText.length,
    shared_buy_signals: sharedSignals.buySignals,
    shared_sell_signals: sharedSignals.sellSignals,
    attachment_text_length: attachmentDiagnosticText.length,
    attachment_buy_signals: attachmentSignals.buySignals,
    attachment_sell_signals: attachmentSignals.sellSignals,
    selected_layer: authoritativeResolution.selectedLayer,
    shared_content_detected: sharedContentDetected,
  });
  logFacebookWorker("FACEBOOK_AUTHORITATIVE_TEXT_SOURCE_COMPARE", {
    metadata_available: metadataResolution.outerText.length > 0,
    metadata_buy_signals: authoritativeResolution.metadataBuySignals,
    metadata_sell_signals: authoritativeResolution.metadataSellSignals,
    dom_available: domLayers.outerText.length > 0,
    dom_buy_signals: authoritativeResolution.domBuySignals,
    dom_sell_signals: authoritativeResolution.domSellSignals,
    sources_conflict: authoritativeResolution.conflict,
  });
  logFacebookWorker("FACEBOOK_AUTHORITATIVE_TEXT_DIAGNOSTIC", {
    post_id: postId,
    source: authoritativePostTextSource,
    provenance: authoritativePostTextProvenance,
    text_length: authoritativePostText.length,
    linked_to_expected_post_id: authoritativePostTextSource !== "NONE",
    comment_text_included: false,
  });
  const requiresCommentCrop = region.screenshotDiagnostic.crop_reasons.includes("COMMENT_BOUNDARY_APPLIED");
  let captureMethod: "ELEMENT_SCREENSHOT" | "CLIP_FALLBACK" = region.cleanPoolUsed && selectedElementBox && !requiresCommentCrop ? "ELEMENT_SCREENSHOT" : "CLIP_FALLBACK";
  let compressed = false;
  let screenshot: Buffer;
  const capture = async (quality: number): Promise<Buffer> => {
    if (captureMethod === "ELEMENT_SCREENSHOT") {
      try {
        return await selectedLocator.screenshot({ type: "jpeg", quality, animations: "disabled", scale: "css", timeout: 30_000 });
      } catch {
        captureMethod = "CLIP_FALLBACK";
      }
    }
    return page.screenshot({ type: "jpeg", quality, clip: region.box, animations: "disabled", scale: "css" });
  };
  try {
    screenshot = await capture(65);
    for (const quality of [45, 30]) {
      if (facebookScreenshotDataUrlLength(screenshot) <= 900_000) break;
      compressed = true;
      screenshot = await capture(quality);
    }
  } finally {
    await selectedLocator.evaluate((element) => element.removeAttribute("data-flip-facebook-capture")).catch(() => undefined);
  }
  const screenshotDataUrl = `data:image/jpeg;base64,${screenshot.toString("base64")}`;
  if (screenshotDataUrl.length > 900_000) throw new Error("FACEBOOK_POST_SCREENSHOT_TOO_LARGE");
  const screenshotDimensions = readJpegDimensions(screenshot) ?? { width: Math.round(selectedElementBox?.width ?? region.box.width), height: Math.round(selectedElementBox?.height ?? region.box.height) };
  logFacebookWorker("FACEBOOK_POST_SCREENSHOT_DIAGNOSTIC", {
    post_id: postId,
    selected_element_box: selectedElementBox,
    screenshot_width: screenshotDimensions.width,
    screenshot_height: screenshotDimensions.height,
    capture_method: captureMethod,
    resized: false,
    compressed,
    ...region.screenshotDiagnostic,
  });
  if (region.mediaFallbackUsed) {
    logFacebookWorker("FACEBOOK_MEDIA_FALLBACK_DIAGNOSTIC", {
      post_id: postId,
      media_candidates: region.mediaCandidateCount,
      selected_media_count: region.selectedMediaCount,
      selected_ancestor_box: selectedElementBox ?? region.screenshotDiagnostic.candidate_box,
      contains_comments: region.containsCommentSection,
      comment_boundary_found: region.screenshotDiagnostic.comment_boundary_y !== null,
      capture_method: captureMethod,
      final_screenshot_width: screenshotDimensions.width,
      final_screenshot_height: screenshotDimensions.height,
    });
  }
  const reportedBox = selectedElementBox && captureMethod === "ELEMENT_SCREENSHOT"
    ? { x: selectedElementBox.x, y: selectedElementBox.y, width: selectedElementBox.width, height: selectedElementBox.height }
    : region.box;
  const mediaCandidates = region.mediaCandidates.slice(0, 5) as FacebookMediaCandidate[];
  const exactBound = mediaCandidates.filter((candidate) => candidate.storyRootPostId === postId && candidate.boundPostId === postId && candidate.rootStoryUnique);
  logFacebookWorker("FACEBOOK_MEDIA_BINDING_SUMMARY", {
    postId,
    candidates: mediaCandidates.length,
    exactBound: exactBound.length,
    foreignRejected: mediaCandidates.filter((candidate) => candidate.foreignPostIdsDetected.length > 0).length,
    ambiguousRejected: mediaCandidates.filter((candidate) => candidate.boundPostId === null).length,
    mirrored: 0,
  });
  return { screenshotDataUrl, imageUrls: [...new Set(exactBound.map((candidate) => candidate.url))], mediaCandidates, publishedAt: region.publishedAt, authoritativePostText, authoritativePostTextSource, authoritativePostTextProvenance, box: reportedBox, candidateCount: region.candidateCount, selectedMediaCount: region.selectedMediaCount, screenshotWidth: screenshotDimensions.width, screenshotHeight: screenshotDimensions.height, captureMethod, compressed };
}

function facebookScreenshotDataUrlLength(screenshot: Buffer): number {
  return "data:image/jpeg;base64,".length + Math.ceil(screenshot.length / 3) * 4;
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: bytes[offset + 3] * 256 + bytes[offset + 4], width: bytes[offset + 5] * 256 + bytes[offset + 6] };
    }
    offset += length;
  }
  return null;
}
