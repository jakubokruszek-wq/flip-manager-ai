import type { WatchedFacebookGroup } from "./types.ts";
export const GROUP_CHECK_INTERVAL_MINUTES={high:5,normal:15,low:60} as const;
export function isFacebookGroupDue(group:WatchedFacebookGroup,now=Date.now()){if(!group.enabled)return false;if(!group.lastCheckedAt)return true;return now-Date.parse(group.lastCheckedAt)>=GROUP_CHECK_INTERVAL_MINUTES[group.priority]*60_000;}
