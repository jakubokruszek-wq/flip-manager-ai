import type { FacebookFieldConfidence, FacebookImageAssessment, FacebookListingIntent } from "../facebook-worker/types";

export type FacebookListingInput = {
  url?: string;
  postText?: string;
  authorName?: string;
  groupName?: string;
  publishedAt?: string;
  images?: string[];
  overrides?: Partial<Pick<FacebookProperty, "title" | "city" | "district" | "neighborhood" | "street" | "price" | "area" | "rooms" | "floor" | "totalFloors" | "marketType" | "condition" | "sellerType" | "description">>;
  analysisConfidence?: number;
  analysisFieldConfidence?: FacebookFieldConfidence;
  analysisFlags?: string[];
  listingIntent?: FacebookListingIntent;
  intentConfidence?: number;
  imageAssessments?: FacebookImageAssessment[];
};

export type FacebookProperty = {
  title: string;
  city: string | null;
  district: string | null;
  neighborhood: string | null;
  street: string | null;
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  marketType: "primary" | "secondary" | null;
  sellerType: "private" | "agency" | null;
  condition: "renovation" | "ready" | null;
  description: string | null;
  originalUrl: string | null;
  images: string[];
  confidence: number;
  fieldConfidence?: FacebookFieldConfidence;
  flags: string[];
  listingIntent?: FacebookListingIntent;
  intentConfidence?: number;
  imageAssessments?: FacebookImageAssessment[];
};

export type FacebookWatcherListing = FacebookProperty & {
  listingId: string;
  status: string;
  groupName: string | null;
  publishedAt: string | null;
  opportunityScore: number;
  crossSourceMatch: boolean;
  source: string;
  workflowStatus: FacebookWorkflowStatus;
  readAt: string | null;
  importedAt: string;
  flipScore: number;
  pricePerSqm: number | null;
  potentialProfit: number | null;
  isNew: boolean;
  highPriority: boolean;
  crossSourceLinks: Array<{ source: string; url: string }>;
};

export const FACEBOOK_WORKFLOW_STATUSES = ["new", "review", "interesting", "crm", "rejected"] as const;
export type FacebookWorkflowStatus = (typeof FACEBOOK_WORKFLOW_STATUSES)[number];

export type FacebookOpportunityAlert = {
  type: "facebook_opportunity";
  listingId: string;
  score: number;
  title: string;
  price: number | null;
  neighborhood: string | null;
  originalUrl: string | null;
};
