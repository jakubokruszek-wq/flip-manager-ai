export type LocationInput = {
  address: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  locationText: string | null;
  title: string | null;
  description: string | null;
};

export type LocationResolution = {
  street: string | null;
  neighborhood: string | null;
  district: string | null;
  city: string | null;
  confidence: number;
  evidence: string;
  source: "deterministic" | "ai" | "combined";
};

export type AiLocationResolution = Omit<LocationResolution, "source">;

export type AiLocationResolver = (input: LocationInput) => Promise<AiLocationResolution | null>;

export type ResolveLocationOptions = {
  aiResolver?: AiLocationResolver;
  allowAi?: boolean;
};

export type LocationMatch = {
  streetMatch: boolean;
  neighborhoodMatch: boolean;
  districtMatch: boolean;
  cityMatch: boolean;
};

// Kontrakt przygotowany pod drugi etap. Nie jest podłączony do rankingu.
export type ComparableReview = {
  comparable: boolean;
  score: number;
  reasons: string[];
};

export type ComparableReviewer<T> = (target: T, comparable: T) => Promise<ComparableReview>;
