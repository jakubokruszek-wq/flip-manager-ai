import type { FacebookFieldConfidence, FacebookImageAssessment, FacebookIntentSource, FacebookListingIntent, FacebookMediaCandidate } from "../facebook-worker/types";

export type FacebookListingInput = {
  url?: string;
  postText?: string;
  authorName?: string;
  groupName?: string;
  publishedAt?: string;
  images?: string[];
  mediaCandidates?: FacebookMediaCandidate[];
  overrides?: Partial<Pick<FacebookProperty, "title" | "city" | "district" | "neighborhood" | "street" | "price" | "area" | "rooms" | "floor" | "totalFloors" | "marketType" | "condition" | "sellerType" | "description">>;
  analysisConfidence?: number;
  analysisFieldConfidence?: FacebookFieldConfidence;
  analysisFlags?: string[];
  listingIntent?: FacebookListingIntent;
  intentConfidence?: number;
  intentSource?: FacebookIntentSource;
  imageAssessments?: FacebookImageAssessment[];
};

export type FacebookSourceFacts = {
  administrativeRent: number | null;
  basement: boolean | null;
  dryingRoom: boolean | null;
  refreshedAt: string | null;
  bathroomRenovated: boolean | null;
  buildingRenovation: string[];
  furnishingIncluded: boolean | null;
  additionalEquipmentPrice: number | null;
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
  intentSource?: FacebookIntentSource;
  imageAssessments?: FacebookImageAssessment[];
  sourceFacts?: FacebookSourceFacts;
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
