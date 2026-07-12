export type PropertyStatus =
  | "draft"
  | "analysis"
  | "acquired"
  | "renovation"
  | "listed"
  | "sold";

export type Property = {
  id: string;
  imageUrl: string | null;
  address: string;
  status: PropertyStatus;
  flipScore: number | null;
  purchasePrice: number | null;
  renovationCost: number | null;
  expectedSalePrice: number | null;
  profit: number | null;
  roi: number | null;
  updatedAt: string;
};
