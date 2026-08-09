import { STYLE_CONFIGS } from "./style-prompts";
import type { RenovationLevel, RenovationOption, RenovationVisualizationInput } from "../types";

const OPTION_PROMPTS: Record<RenovationOption, string> = {
  floors: "replace visible floor finishes", doors: "replace visible non-structural interior door finishes without moving openings",
  kitchen: "renovate visible kitchen cabinetry and finishes", bathroom: "renovate visible bathroom fixtures and finishes",
  lighting: "update lighting fixtures", furniture: "replace movable furniture", carpentry: "add non-structural fitted carpentry",
  decorations: "update textiles and decorations", "preserve-layout": "strictly preserve the current functional layout",
};

export function buildRenovationPrompt(input: RenovationVisualizationInput): string {
  return [
    "Create one photorealistic post-renovation image by editing the supplied reference photograph.",
    "ABSOLUTE PRESERVATION: keep the exact camera position, perspective, room geometry, proportions, existing walls, installations, windows, doors and every opening.",
    "Never remove, add, resize or relocate a wall, window, door, opening, column, radiator or permanent installation.",
    "Change only non-structural finishes: floors, wall finishes, lighting fixtures, movable furniture, visible kitchen or bathroom finishes, decorations and joinery.",
    `Style direction: ${STYLE_CONFIGS[input.style].prompt}.`, levelPrompt(input.renovationLevel),
    `Selected scope: ${input.options.map((option) => OPTION_PROMPTS[option]).join(", ") || "visual refresh only"}.`,
    `Target budget: up to ${input.budget.toLocaleString("pl-PL")} PLN. Keep material choices plausible for this budget.`,
    input.instructions ? `Additional requirements, subordinate to preservation rules: ${input.instructions}` : "",
    "Return only the edited image. No captions, labels, watermark, collage or split-screen.",
  ].filter(Boolean).join("\n");
}

function levelPrompt(level: RenovationLevel): string {
  if (level === "refresh") return "Scope: refresh — paint, lighting, textiles, decor and movable furniture; retain serviceable fixed finishes.";
  if (level === "standard") return "Scope: standard renovation — replace visible finishes and selected fixtures without changing structure or installations.";
  return "Scope: general renovation of finishes, cabinetry, fixtures and furniture while preserving all geometry and permanent installations.";
}
