export type BrowserPushSubscription = { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } };
export type PushPayload = { title: string; body: string; icon?: string; badge?: string; data: { listingId?: string; url: string; originalUrl?: string | null; eventType: string } };
