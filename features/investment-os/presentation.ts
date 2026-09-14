const currencyNumber = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });

function parseMoneyText(value: string): number | null {
  let normalized = value.trim().replace(/[\s\u00a0\u202f]/g, "").replace(/PLN|zł/gi, "");
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");

  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    normalized = normalized.replaceAll(groupingSeparator, "");
    if (decimalSeparator === ",") normalized = normalized.replace(",", ".");
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const decimals = normalized.length - normalized.lastIndexOf(separator) - 1;
    if (decimals === 3) normalized = normalized.replaceAll(separator, "");
    else if (separator === ",") normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatPLNDisplay(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${currencyNumber.format(value)}\u00a0zł`;
}

export function formatPercentDisplay(value: number | null | undefined, maximumFractionDigits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const formatted = new Intl.NumberFormat("pl-PL", { maximumFractionDigits }).format(value);
  return `${formatted.startsWith("-") ? `−${formatted.slice(1)}` : formatted}%`;
}

export function formatKnownMoneyText(value: string): string | null {
  const clean = value.trim().replace(/\.$/, "");
  const match = clean.match(/^(Opening|Target|Never exceed):\s*(-?\d[\d\s\u00a0\u202f.,]*)\s*PLN$/i)
    ?? clean.match(/^(Oferta otwierająca|Cena docelowa|Nie przekraczaj):\s*(-?\d[\d\s\u00a0\u202f.,]*)(?:\s*(?:PLN|zł))?$/i);
  if (!match) return null;

  const parsed = parseMoneyText(match[2]);
  if (parsed === null) return null;
  const amount = formatPLNDisplay(parsed);
  if (amount === "—") return null;

  const directive = match[1].toLowerCase();
  const label = directive === "opening" || directive === "oferta otwierająca" ? "Oferta otwierająca" : directive === "target" || directive === "cena docelowa" ? "Cena docelowa" : "Nie przekraczaj";
  return `${label}: ${amount}`;
}

/** Formats known engine-generated prose without changing the underlying calculation or claim. */
export function formatInvestmentText(value: string): string | null {
  const knownMoney = formatKnownMoneyText(value);
  if (knownMoney) return knownMoney;

  const gate = value.match(/^([A-Za-z_]+): (confirmed|requires evidence)$/i);
  if (gate) {
    const field = ({ askingPrice: "cena ofertowa", areaM2: "powierzchnia", rooms: "liczba pokoi", city: "miasto", district: "dzielnica", street: "dokładny adres", buildingType: "typ budynku", ownership: "forma własności", legalStatus: "stan prawny", marketEvidence: "dane rynkowe", renovationScope: "zakres remontu", identity: "tożsamość ogłoszenia", economics: "ekonomika", riskReview: "ocena ryzyka", floor: "piętro", floorsTotal: "liczba pięter", yearBuilt: "rok budowy", monthlyFee: "czynsz" } as Record<string, string>)[gate[1]];
    if (field) return `${field[0].toUpperCase()}${field.slice(1)}: ${gate[2].toLowerCase() === "confirmed" ? "potwierdzone" : "wymaga dowodu"}`;
  }

  const thesis = value.match(/^Bazowy zysk (.+?) PLN jest ważny tylko przy spełnieniu wszystkich bramek\.$/);
  if (thesis) {
    const amount = parseMoneyText(thesis[1]);
    if (amount !== null) return `Bazowy zysk ${formatPLNDisplay(amount)} jest ważny tylko przy spełnieniu wszystkich bramek.`;
  }

  const scenario = value.match(/^(Bear|Base|Bull): resale (unknown|-?\d[\d\s\u00a0\u202f.,]*), profit (unknown|-?\d[\d\s\u00a0\u202f.,]*)\.$/i);
  if (scenario) {
    const label = ({ bear: "Ostrożny", base: "Bazowy", bull: "Optymistyczny" } as Record<string, string>)[scenario[1].toLowerCase()];
    const amount = (raw: string) => raw.toLowerCase() === "unknown" ? "brak danych" : formatPLNDisplay(parseMoneyText(raw));
    return `${label}: sprzedaż ${amount(scenario[2])}, zysk ${amount(scenario[3])}.`;
  }

  const condition = value.match(/^Cena zakupu <= (.+) PLN$/);
  if (condition) {
    const amount = parseMoneyText(condition[1]);
    if (amount !== null) return `Cena zakupu nie wyższa niż ${formatPLNDisplay(amount)}`;
  }

  const walkAway = value.match(/^Cena > (.+) PLN$/);
  if (walkAway) {
    const amount = parseMoneyText(walkAway[1]);
    if (amount !== null) return `Cena powyżej ${formatPLNDisplay(amount)}`;
  }

  const risk = value.match(/^Cena ofertowa przekracza maksimum o (-?\d[\d\s\u00a0\u202f.,]*)\s*(?:PLN|zł)$/i);
  if (risk) {
    const amount = parseMoneyText(risk[1]);
    if (amount !== null) return `Cena ofertowa przekracza maksimum o ${formatPLNDisplay(amount)}`;
  }

  return null;
}
