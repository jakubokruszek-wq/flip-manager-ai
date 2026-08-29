import type { FacebookListingInput } from "@/features/facebook-watcher/types";

export const FACEBOOK_GROUP_PRIORITIES = ["high", "normal", "low"] as const;
export const FACEBOOK_GROUP_ACCESS = ["CONNECTED", "MANUAL_IMPORT", "AUTH_REQUIRED", "UNAVAILABLE"] as const;
export type FacebookGroupPriority = (typeof FACEBOOK_GROUP_PRIORITIES)[number];
export type FacebookGroupAccessStatus = (typeof FACEBOOK_GROUP_ACCESS)[number];
export const FACEBOOK_SOURCE_TYPES = ["GROUP", "PROFILE"] as const;
export type FacebookSourceType = (typeof FACEBOOK_SOURCE_TYPES)[number];

export type WatchedFacebookGroup = {
  id: string;
  type?: FacebookSourceType;
  sourceId?: string;
  name: string;
  url: string;
  city: string;
  district: string | null;
  neighborhood: string | null;
  priority: FacebookGroupPriority;
  keywords: string[];
  enabled: boolean;
  accessStatus: FacebookGroupAccessStatus;
  lastCheckedAt: string | null;
  importedPosts: number;
  newToday: number;
  opportunities: number;
  lastError: string | null;
};

export type FacebookGroupInput = Pick<WatchedFacebookGroup, "name" | "url" | "city" | "district" | "neighborhood" | "priority" | "keywords" | "enabled"> & { type?: FacebookSourceType; sourceId?: string };
export type AddWatchedFacebookGroupResult =
  | { success: true; duplicate: false; group: WatchedFacebookGroup }
  | { success: false; duplicate: true; error: "Ta grupa jest już obserwowana."; group: WatchedFacebookGroup }
  | { success: false; duplicate: false; error: string; validationError: true };
export type GroupCheckResult = { status: FacebookGroupAccessStatus; posts: FacebookListingInput[]; checkedAt: string; error?: string };
export interface FacebookGroupSourceAdapter { checkGroup(group: WatchedFacebookGroup): Promise<GroupCheckResult> }
