import type { FacebookPostSnapshot } from "@/features/facebook-worker/types";

import type { FacebookCollectorBatch } from "./facebook-batch";

export const COLLECTOR_MAX_POST_AGE_MS = 72 * 60 * 60 * 1_000;

export function collectorPostsForProcessing(batch: FacebookCollectorBatch, now = Date.now()): FacebookPostSnapshot[] {
  return batch.posts.filter((post) => isCollectorPostFresh(post.publishedAt, now)).map((post) => ({
    postId: post.postId,
    groupId: post.sourceId,
    permalink: post.permalink,
    authoritativePostText: post.text,
    authoritativePostTextSource: "POST_REGION_DOM",
    authoritativePostTextProvenance: "ROOT_AUTHOR_MESSAGE",
    text: post.text ?? "",
    imageUrls: [],
    mediaCandidates: [],
    publishedAt: post.publishedAt,
    vision: null,
  }));
}

export function isCollectorPostFresh(publishedAt: string | null, now = Date.now()): boolean {
  return publishedAt === null || now - Date.parse(publishedAt) <= COLLECTOR_MAX_POST_AGE_MS;
}

export const COLLECTOR_IMAGE_IMPORT_OPTIONS = { preserveExistingImagesOnEmptyInput: true } as const;
