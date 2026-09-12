import { z } from "zod";

/** Integer-only PLN arithmetic for the Investment OS domain. */
export type MoneyCents = number & { readonly __brand: "MoneyCents" };
export type BasisPoints = number & { readonly __brand: "BasisPoints" };
export const moneyCentsSchema = z.number().int();
export const basisPointsSchema = z.number().int().min(0).max(10_000);

export function moneyCents(valuePLN: number): MoneyCents {
  if (!Number.isFinite(valuePLN)) throw new Error("MONEY_NOT_FINITE");
  return safeInteger(roundHalfUp(valuePLN * 100));
}

export function basisPoints(value: number): BasisPoints {
  if (!basisPointsSchema.safeParse(value).success) throw new Error("RATE_INVALID_BASIS_POINTS");
  return value as BasisPoints;
}

export function addMoney(left: MoneyCents, right: MoneyCents): MoneyCents { return safeInteger(left + right); }
export function subtractMoney(left: MoneyCents, right: MoneyCents): MoneyCents { return safeInteger(left - right); }

/** Half-up rounding for multiplication by a rate represented in basis points. */
export function multiplyByRate(value: MoneyCents, rate: BasisPoints): MoneyCents {
  return multiplyByFraction(value, BigInt(rate), BigInt(10_000));
}

/** Multiplies an amount by a decimal quantity (e.g. m² or months), rounding half-up to one grosz. */
export function multiplyMoneyByQuantity(value: MoneyCents, quantity: number): MoneyCents {
  if (!Number.isFinite(quantity)) throw new Error("MONEY_QUANTITY_NOT_FINITE");
  const scale = BigInt(1_000_000);
  const scaled = BigInt(roundHalfUp(Math.abs(quantity) * Number(scale)));
  const result = multiplyByFraction(value, scaled, scale);
  return (quantity < 0 ? -result : result) as MoneyCents;
}

/** Exact integer-ratio multiplication with half-up rounding; useful for compounded finance rates. */
export function multiplyByFraction(value: MoneyCents, numerator: bigint, denominator: bigint): MoneyCents {
  if (denominator <= BigInt(0) || numerator < BigInt(0)) throw new Error("MONEY_RATIO_INVALID");
  const product = BigInt(value) * numerator;
  const sign = product < BigInt(0) ? BigInt(-1) : BigInt(1);
  const magnitude = product < BigInt(0) ? -product : product;
  const rounded = sign * ((magnitude * BigInt(2) + denominator) / (denominator * BigInt(2)));
  return safeInteger(Number(rounded));
}

export function moneyToPLN(value: MoneyCents): number { return value / 100; }

/** Half-up integer division; divisor must be positive. */
export function divideMoney(value: MoneyCents, divisor: number): MoneyCents {
  if (!Number.isInteger(divisor) || divisor <= 0) throw new Error("MONEY_DIVISOR_INVALID");
  return multiplyByFraction(value, BigInt(1), BigInt(divisor));
}

/** Divides by a decimal quantity (e.g. m²), rounding half-up to one grosz. */
export function divideMoneyByQuantity(value: MoneyCents, divisor: number): MoneyCents {
  if (!Number.isFinite(divisor) || divisor <= 0) throw new Error("MONEY_DIVISOR_INVALID");
  const scale = BigInt(1_000_000);
  const scaled = BigInt(roundHalfUp(divisor * Number(scale)));
  return multiplyByFraction(value, scale, scaled);
}

export function formatPLN(value: MoneyCents): string {
  return new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100);
}

export function percentToBasisPoints(percent: number): BasisPoints {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error("RATE_OUT_OF_RANGE");
  return basisPoints(roundHalfUp(percent * 100));
}

function safeInteger(value: number): MoneyCents {
  if (!Number.isSafeInteger(value)) throw new Error("MONEY_OUT_OF_SAFE_RANGE");
  return value as MoneyCents;
}

function roundHalfUp(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  return sign * Math.floor(magnitude + 0.5 + Number.EPSILON * Math.max(1, magnitude) * 2);
}
