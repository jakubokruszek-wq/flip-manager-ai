import { z } from "zod";

/** Integer-only PLN arithmetic for the Investment OS domain. */
export type MoneyCents = number & { readonly __brand: "MoneyCents" };
export type BasisPoints = number & { readonly __brand: "BasisPoints" };
export const moneyCentsSchema = z.number().int();
export const basisPointsSchema = z.number().int().min(0).max(10_000);

export function moneyCents(valuePLN: number): MoneyCents {
  if (!Number.isFinite(valuePLN)) throw new Error("MONEY_NOT_FINITE");
  return Math.round(valuePLN * 100) as MoneyCents;
}

export function basisPoints(value: number): BasisPoints {
  if (!basisPointsSchema.safeParse(value).success) throw new Error("RATE_INVALID_BASIS_POINTS");
  return value as BasisPoints;
}

export function addMoney(left: MoneyCents, right: MoneyCents): MoneyCents { return (left + right) as MoneyCents; }
export function subtractMoney(left: MoneyCents, right: MoneyCents): MoneyCents { return (left - right) as MoneyCents; }

/** Half-up rounding for multiplication by a rate represented in basis points. */
export function multiplyByRate(value: MoneyCents, rate: BasisPoints): MoneyCents {
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.floor((Math.abs(value) * rate + 5000) / 10000)) as MoneyCents;
}

/** Half-up integer division; divisor must be positive. */
export function divideMoney(value: MoneyCents, divisor: number): MoneyCents {
  if (!Number.isInteger(divisor) || divisor <= 0) throw new Error("MONEY_DIVISOR_INVALID");
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.floor((Math.abs(value) + divisor / 2) / divisor)) as MoneyCents;
}

export function formatPLN(value: MoneyCents): string {
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100);
}

export function percentToBasisPoints(percent: number): BasisPoints {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("RATE_OUT_OF_RANGE");
  return basisPoints(Math.round(percent * 100));
}
