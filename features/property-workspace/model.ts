export const stages = { contact: "Do kontaktu", viewing: "Oglądanie", analysis: "Analiza", negotiation: "Negocjacje", acquired: "Kupiona", renovation: "Remont", listed: "Sprzedaż", sold: "Sprzedana", rejected: "Odrzucona" } as const;
export type Stage = keyof typeof stages;
export const investmentStages: Stage[] = ["acquired", "renovation", "listed", "sold"];
export const categories = { transaction: "Zakup i formalności", renovation: "Remont", furnishing: "Wyposażenie", holding: "Utrzymanie", finance: "Finansowanie", sale: "Sprzedaż", other: "Inne" } as const;
export type Category = keyof typeof categories;
export const fileCategories = { viewing: "Oglądanie", deed: "Akt i umowy", document: "Pozostałe dokumenty", before: "Przed remontem", during: "W trakcie remontu", after: "Po remoncie", visualization: "Wizualizacje i rzuty", invoice: "Faktury i paragony" } as const;
export type FileCategory = keyof typeof fileCategories;
export type Expense = { id: string; description: string; supplier: string; invoiceNumber: string; date: string; amount: number; category: Category; paid: boolean; refund: boolean; fileId: string | null };
export type Task = { id: string; title: string; dueDate: string; contractor: string; done: boolean };
export type Workspace = { schema: 1; stage: Stage; contact: string; viewingAt: string; notes: string; checklist: string[]; offerPrice: number | null; purchasePrice: number | null; purchaseDate: string; salePrice: number | null; saleDate: string; expectedSalePrice: number | null; targetDate: string; budgets: Record<Category, number | null>; expenses: Expense[]; tasks: Task[] };
export type WorkspaceFile = { id: string; name: string; category: FileCategory; mime: string; size: number; url: string; created_at: string };
export const viewingChecks = ["Stan instalacji elektrycznej", "Piony i instalacja wodna", "Wilgoć i wentylacja", "Okna i ogrzewanie", "Stan budynku i plan remontów", "Stan prawny i opłaty", "Wymiary i układ pomieszczeń"];
export function emptyWorkspace(status = "draft"): Workspace {
  const stage: Stage = Object.hasOwn(stages, status) ? status as Stage : "contact";
  return { schema: 1, stage, contact: "", viewingAt: "", notes: "", checklist: [], offerPrice: null, purchasePrice: null, purchaseDate: "", salePrice: null, saleDate: "", expectedSalePrice: null, targetDate: "", budgets: { transaction: null, renovation: null, furnishing: null, holding: null, finance: null, sale: null, other: null }, expenses: [], tasks: [] };
}
export function isInvestment(stage: Stage) { return investmentStages.includes(stage); }
export function statusForStage(stage: Stage) { return isInvestment(stage) ? stage : stage === "contact" || stage === "rejected" ? "draft" : "analysis"; }
const currency = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
export function money(cents: number | null) { return cents === null ? "—" : currency.format(cents / 100); }
export function parseMoney(text: string): number | null {
  if (!text.trim()) return null;
  const normalized = text.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new Error("Podaj kwotę z maksymalnie dwoma miejscami po przecinku.");
  const [whole, decimal = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 100_000_000_000) throw new Error("Kwota jest za duża.");
  return cents;
}
export function totals(w: Workspace) {
  const byCategory = Object.fromEntries(Object.keys(categories).map(key => [key, 0])) as Record<Category, number>;
  let committed = 0, paid = 0;
  for (const expense of w.expenses) {
    const amount = expense.refund ? -expense.amount : expense.amount;
    committed += amount; if (expense.paid) paid += amount;
    byCategory[expense.category] += amount;
  }
  const budgetComplete = Object.values(w.budgets).every(v => v !== null);
  const budget = Object.values(w.budgets).reduce<number>((sum, v) => sum + (v ?? 0), 0);
  const cost = w.purchasePrice === null ? null : w.purchasePrice + committed;
  const purchaseBasis = w.purchasePrice ?? w.offerPrice;
  const finalExtra = Object.keys(categories).reduce((sum, key) => sum + Math.max(w.budgets[key as Category] ?? 0, byCategory[key as Category]), 0);
  const estimatedCost = purchaseBasis === null || !budgetComplete ? null : purchaseBasis + finalExtra;
  const profit = w.stage === "sold"
    ? w.salePrice === null || cost === null ? null : w.salePrice - cost
    : w.expectedSalePrice === null || estimatedCost === null ? null : w.expectedSalePrice - estimatedCost;
  const basis = w.stage === "sold" ? cost : estimatedCost;
  return { committed, paid, unpaid: committed - paid, byCategory, budget, budgetComplete, remaining: budget - committed, cost, estimatedCost, profit, roi: profit === null || basis === null || basis <= 0 ? null : profit / basis * 100 };
}
export type WorkspaceEvent = { version: number; stage: Stage; expense_count: number; task_count: number; created_at: string };
export function invoiceIdentity(supplier: string, invoiceNumber: string) {
  const clean = (value: string) => value.normalize("NFKC").toLocaleLowerCase("pl").replace(/\s+/gu, " ").trim();
  const digits = supplier.replace(/\D/g, "");
  const seller = digits.length === 10 && /^(?:nip[:\s]*)?[\d\s-]+$/i.test(supplier) ? digits : clean(supplier);
  return seller && invoiceNumber ? `${seller}:${clean(invoiceNumber).replace(/\s+/gu, "")}` : null;
}

function record(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Nieprawidłowe dane."); return v as Record<string, unknown>; }
function str(v: unknown, max = 2000) { if (typeof v !== "string" || v.length > max) throw new Error("Nieprawidłowa długość tekstu."); return v.trim(); }
function amount(v: unknown): number | null { if (v === null) return null; if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 100_000_000_000) throw new Error("Nieprawidłowa kwota."); return v; }
function date(v: unknown) { const text = str(v, 10); if (text && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || new Date(text).toISOString().slice(0, 10) !== text)) throw new Error("Nieprawidłowa data."); return text; }
function id(v: unknown) { const text = str(v, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) throw new Error("Nieprawidłowy identyfikator."); return text; }
function choice<T extends string>(v: unknown, options: Record<T, string>): T { if (typeof v !== "string" || !Object.hasOwn(options, v)) throw new Error("Nieprawidłowy wybór."); return v as T; }
function bool(v: unknown) { if (typeof v !== "boolean") throw new Error("Nieprawidłowy znacznik."); return v; }
function array(v: unknown, max: number) { if (!Array.isArray(v) || v.length > max) throw new Error("Za dużo wpisów."); return v as unknown[]; }
export function parseWorkspace(value: unknown): Workspace {
  const v = record(value); if (v.schema !== 1) throw new Error("Nieobsługiwana wersja danych.");
  const budgets = record(v.budgets);
  const expenses = array(v.expenses, 2000).map(item => { const e = record(item); const result: Expense = { id: id(e.id), description: str(e.description, 500), supplier: str(e.supplier, 300), invoiceNumber: str(e.invoiceNumber, 150), date: date(e.date), amount: amount(e.amount) ?? 0, category: choice(e.category, categories), paid: bool(e.paid), refund: bool(e.refund), fileId: e.fileId === null ? null : id(e.fileId) }; if (result.invoiceNumber && !result.supplier) throw new Error("Wpisz sprzedawcę lub NIP, aby sprawdzić powtórzenia faktury."); if (!result.description || result.amount <= 0) throw new Error("Koszt wymaga opisu i kwoty większej od zera."); return result; });
  const seen = new Set<string>();
  for (const e of expenses) {
    const identity = invoiceIdentity(e.supplier, e.invoiceNumber);
    const key = identity ? `invoice:${identity}` : null;
    for (const candidate of [`id:${e.id}`, e.fileId ? `file:${e.fileId}` : null, key]) { if (!candidate) continue; if (seen.has(candidate)) throw new Error("Ta faktura lub dokument są już zapisane. Nie doliczono ich ponownie."); seen.add(candidate); }
  }
  const tasks = array(v.tasks, 500).map(item => { const t = record(item); return { id: id(t.id), title: str(t.title, 500), dueDate: date(t.dueDate), contractor: str(t.contractor, 300), done: bool(t.done) }; });
  if (new Set(tasks.map(t => t.id)).size !== tasks.length || tasks.some(t => !t.title)) throw new Error("Nieprawidłowe zadania.");
  const viewingAt = str(v.viewingAt, 16); if (viewingAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(viewingAt) || !Number.isFinite(Date.parse(viewingAt)))) throw new Error("Nieprawidłowy termin oglądania.");
  const result: Workspace = { schema: 1, stage: choice(v.stage, stages), contact: str(v.contact, 1000), viewingAt, notes: str(v.notes, 30000), checklist: array(v.checklist, viewingChecks.length).map(x => choice(x, Object.fromEntries(viewingChecks.map(s => [s, s])))), offerPrice: amount(v.offerPrice), purchasePrice: amount(v.purchasePrice), purchaseDate: date(v.purchaseDate), salePrice: amount(v.salePrice), saleDate: date(v.saleDate), expectedSalePrice: amount(v.expectedSalePrice), targetDate: date(v.targetDate), budgets: Object.fromEntries(Object.keys(categories).map(k => [k, amount(budgets[k])])) as Workspace["budgets"], expenses, tasks };
  if (isInvestment(result.stage) && (result.purchasePrice === null || !result.purchaseDate)) throw new Error("Przed utworzeniem inwestycji wpisz cenę i datę zakupu.");
  if (result.stage === "sold" && (result.salePrice === null || !result.saleDate)) throw new Error("Wpisz cenę i datę sprzedaży.");
  return result;
}
