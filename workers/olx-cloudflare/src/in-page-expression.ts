import { IN_PAGE_BUNDLE } from "./generated/in-page-bundle.ts";
import { EXTRACT_IN_PAGE_SOURCE } from "./olx-page.ts";

/**
 * The single Runtime.evaluate expression sent to each OLX page: extraction,
 * Finder parsing and verification, all in the browser. Everything is scoped in
 * one function (no globals are left on the page) and nothing is eval'ed inside
 * the page, so OLX's Content-Security-Policy does not matter.
 */
export function inPageExpression(): string {
  return `(function () { var __name = function (target) { return target; }; ${IN_PAGE_BUNDLE}
var extracted = ${EXTRACT_IN_PAGE_SOURCE}(FlipOlxInPage.isOlxChallengeHtml);
return FlipOlxInPage.processExtractedPage(JSON.parse(extracted)); })()`;
}
