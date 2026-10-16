/** Conditional arithmetic, NOT transaction qualification or a tax-return engine.
 * Primary provisions/temporal limitations: docs/deal-room-30-p2b2-model.md.
 * No rate/exemption is selected from a legal-form label or free-text evidence.
 */
export const TAX_RULES = {
  PRIVATE_PIT19: { label: "Prywatna sprzedaż opodatkowana — PIT 19%", percent: 19, basis: "Ustalona podstawa PIT, nie zysk ekonomiczny", provision: "PIT art. 30e", scenario: "PRIVATE" },
  JDG_LINEAR19: { label: "JDG — PIT liniowy 19%", percent: 19, basis: "Podstawa liniowego PIT po właściwych korektach", provision: "PIT art. 9a, 30c", scenario: "JDG" },
  COMPANY_CIT19: { label: "Spółka — klasyczny CIT 19%", percent: 19, basis: "Podstawa klasycznego CIT", provision: "CIT art. 19 ust. 1 pkt 1", scenario: "SP_ZOO" },
  DIVIDEND_PIT19: { label: "Dywidenda osoby fizycznej — PIT 19%", percent: 19, basis: "Uchwalona dywidenda brutto, nie kapitał ani przychód sprzedaży", provision: "PIT art. 30a ust. 1 pkt 4", scenario: "SP_ZOO" },
  PCC2: { label: "PCC nieruchomości — 2%", percent: 2, basis: "Wartość rynkowa przedmiotu zakupu", provision: "PCC art. 6, 7; zastrzeżenia art. 2, 9", scenario: null },
  PCC6: { label: "PCC szczególny — 6%", percent: 6, basis: "Wartość rynkowa kwalifikowanego szóstego/kolejnego lokalu", provision: "PCC art. 7a", scenario: null },
  VAT_GROSS23: { label: "Faktura brutto — VAT 23%", percent: 23, basis: "Kwota brutto jednej kwalifikowanej pozycji/faktury", provision: "VAT art. 41, 146ef", scenario: null },
  VAT_GROSS8: { label: "Faktura brutto — VAT 8%", percent: 8, basis: "Kwota brutto jednej kwalifikowanej pozycji/faktury", provision: "VAT art. 41, 146ef", scenario: null },
} as const;
export type TaxRule = keyof typeof TAX_RULES;
export type ConditionalTax = {
  status: "CONDITIONAL_ARITHMETIC"; rule: TaxRule; inputPLN: number; roundedBasePLN: number | null;
  amountPLN: number; netInvoicePLN: number | null; provision: string;
  applicability: "UNKNOWN"; actualLiabilityPLN: null; effectiveFrom: null; effectiveTo: null;
};
export function isTaxRule(value: string): value is TaxRule { return Object.hasOwn(TAX_RULES, value); }
// Strings are deliberate: Q&A retains the exact decimal declaration, without a float/coercion path.
export function validTaxAmount(value: string): boolean {
  return /^(?:0|[1-9]\d{0,8}|100000000)(?:\.\d{1,2})?$/.test(value) && Number(value) <= 100000000;
}
export function conditionalTax(rule: string, amount: string): ConditionalTax | null {
  if (!isTaxRule(rule) || !validTaxAmount(amount)) return null;
  const [whole, fraction = ""] = amount.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  const definition = TAX_RULES[rule];
  const invoice = rule === "VAT_GROSS23" || rule === "VAT_GROSS8";
  const roundedBasePLN = invoice ? null : Math.floor((cents + 50) / 100);
  // Integer ratios stay below Number.MAX_SAFE_INTEGER for the explicit input bound.
  const taxCents = invoice ? Math.floor((cents * definition.percent + (100 + definition.percent) / 2) / (100 + definition.percent)) : Math.floor((roundedBasePLN! * definition.percent + 50) / 100) * 100;
  return { status: "CONDITIONAL_ARITHMETIC", rule, inputPLN: cents / 100, roundedBasePLN, amountPLN: taxCents / 100, netInvoicePLN: invoice ? (cents - taxCents) / 100 : null, provision: definition.provision, applicability: "UNKNOWN", actualLiabilityPLN: null, effectiveFrom: null, effectiveTo: null };
}
