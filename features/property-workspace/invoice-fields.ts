import { parseMoney } from "./model";
function validNip(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 10) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  return weights.reduce((sum, weight, i) => sum + weight * Number(digits[i]), 0) % 11 === Number(digits[9]);
}
export function invoiceDraft(text: string) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const strong = [...lines].reverse().find(line => /(?:razem\s*brutto|warto[śs][ćc]\s*brutto|[łl][ąa]czna\s*kwota\s*brutto)/i.test(line));
  const total = strong ?? [...lines].reverse().find(line => /(?:suma\s*(?:PLN|z[łl])|^razem\s*[:\d]|do\s*zap[łl]aty)/i.test(line) && !/pozosta[łl]/i.test(line));
  const values = total?.match(/\d[\d\s]*(?:[,.]\d{2})(?!\d)/g);
  let amount: number | null = null;
  try { if (values?.length === 1) amount = parseMoney(values[0]); } catch { /* Unknown totals stay empty. */ }
  const number = text.match(/(?:faktura(?:\s+vat)?\s+(?:nr[.:]?\s*)?|nr\s*faktury\s*:?\s*)([\w/-]*\d[\w/-]*)/i)?.[1] ?? "";
  const rawDate = text.match(/(?:data\s*wystawienia|wystawiono)\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{2}[.-]\d{2}[.-]\d{4})/i)?.[1] ?? "";
  const date = /^\d{2}[.-]/.test(rawDate) ? rawDate.split(/[.-]/).reverse().join("-") : rawDate;
  const sellerZone = text.split(/nabywca|kupuj[ąa]cy/i)[0];
  const nip = sellerZone.match(/\bNIP\s*[:\s]*([\d][\d -]{8,15}[\d])/i)?.[1]?.trim() ?? "";
  return { invoiceNumber: /^\d{4}-\d{2}-\d{2}$/.test(number) ? "" : number.slice(0, 150), date, amount, supplier: validNip(nip) ? `NIP ${nip.replace(/\D/g, "")}` : "" };
}
