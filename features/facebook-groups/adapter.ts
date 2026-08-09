import type { FacebookGroupSourceAdapter } from "./types";

export const safeFacebookGroupAdapter: FacebookGroupSourceAdapter = {
  async checkGroup() {
    return {
      status: "MANUAL_IMPORT",
      posts: [],
      checkedAt: new Date().toISOString(),
      error: "Ta grupa wymaga ręcznego importu lub autoryzowanego źródła danych.",
    };
  },
};
