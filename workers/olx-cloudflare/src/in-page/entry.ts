/**
 * Entry of the bundle evaluated inside the Browser Run page (see
 * scripts/build-in-page-bundle.mjs). It contains the Finder parser itself, so
 * normalisation rules are never duplicated.
 */
export { isOlxChallengeHtml } from "../../../../features/flip-finder/olx-parser.ts";
export { processExtractedPage } from "../olx-page.ts";
