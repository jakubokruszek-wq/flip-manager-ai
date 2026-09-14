import assert from "node:assert/strict";
import test from "node:test";
import { formatInvestmentText, formatKnownMoneyText, formatPercentDisplay, formatPLNDisplay } from "./presentation.ts";

test("PLN presentation rounds to whole złoty and preserves Polish grouping", () => {
  assert.equal(formatPLNDisplay(286_450.25).replaceAll("\u00a0", " "), "286 450 zł");
  assert.equal(formatPLNDisplay(null), "—");
});

test("percent presentation uses Polish decimal commas", () => {
  assert.equal(formatPercentDisplay(12.8), "12,8%");
  assert.equal(formatPercentDisplay(-2.4), "−2,4%");
});

test("known English investment money directives are localized and rounded", () => {
  const openingOffer = formatKnownMoneyText("Opening: 213105.03 PLN");
  assert.equal(openingOffer?.replaceAll("\u00a0", " "), "Oferta otwierająca: 213 105 zł");
  assert.equal(formatKnownMoneyText("Oferta otwierająca: 213105.03."), openingOffer);
  assert.equal(formatKnownMoneyText("Target: 79 500,45 PLN")?.replaceAll("\u00a0", " "), "Cena docelowa: 79 500 zł");
  assert.equal(formatKnownMoneyText("unrecognized 213105.03 PLN"), null);
});

test("engine investment narratives localize scenario labels and use grouped whole PLN", () => {
  assert.equal(formatInvestmentText("Bazowy zysk 63872.55 PLN jest ważny tylko przy spełnieniu wszystkich bramek.")?.replaceAll("\u00a0", " "), "Bazowy zysk 63 873 zł jest ważny tylko przy spełnieniu wszystkich bramek.");
  assert.equal(formatInvestmentText("Bear: resale 420000, profit 12500.25.")?.replaceAll("\u00a0", " "), "Ostrożny: sprzedaż 420 000 zł, zysk 12 500 zł.");
  assert.equal(formatInvestmentText("Bull: resale unknown, profit unknown."), "Optymistyczny: sprzedaż brak danych, zysk brak danych.");
  assert.equal(formatInvestmentText("Cena zakupu <= 287500 PLN")?.replaceAll("\u00a0", " "), "Cena zakupu nie wyższa niż 287 500 zł");
  assert.equal(formatInvestmentText("Cena > 287500.45 PLN")?.replaceAll("\u00a0", " "), "Cena powyżej 287 500 zł");
  assert.equal(formatInvestmentText("legalStatus: requires evidence"), "Stan prawny: wymaga dowodu");
  assert.equal(formatInvestmentText("ownership: confirmed"), "Forma własności: potwierdzone");
  assert.equal(formatInvestmentText("Cena ofertowa przekracza maksimum o 63872,55 zł")?.replaceAll("\u00a0", " "), "Cena ofertowa przekracza maksimum o 63 873 zł");
  assert.equal(formatInvestmentText("Nieznany tekst 213105.03 PLN"), null);
});
