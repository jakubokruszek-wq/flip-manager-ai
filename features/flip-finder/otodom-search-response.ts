export const OTODOM_AUTOMATION_BLOCKED_MESSAGE =
  "Otodom tymczasowo zablokował automatyczne pobieranie ofert. Filtr i wcześniejsze wyniki pozostały zapisane.";

export type OtodomSearchFailureKind =
  | "forbidden"
  | "rate_limited"
  | "timeout"
  | "dns"
  | "connection"
  | "security_redirect"
  | "challenge"
  | "empty_response"
  | "changed_structure"
  | "unrecognized_response";

export type OtodomSearchResponseDetails = {
  status: number;
  contentType: string;
  finalUrl: string;
  body: string;
};

type ErrorWithCode = {
  name?: unknown;
  code?: unknown;
  cause?: unknown;
};

export function classifyOtodomFetchError(error: unknown): OtodomSearchFailureKind {
  const details = errorDetails(error);
  const name = typeof details.name === "string" ? details.name : "";
  const code = typeof details.code === "string" ? details.code : "";

  if (name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT") {
    return "timeout";
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "dns";
  }

  return "connection";
}

export function inspectOtodomSearchResponse(
  details: OtodomSearchResponseDetails,
): OtodomSearchFailureKind | null {
  if (details.status === 403) {
    return "forbidden";
  }

  if (details.status === 429) {
    return "rate_limited";
  }

  if (isSecurityUrl(details.finalUrl)) {
    return "security_redirect";
  }

  if (isChallengeHtml(details.body)) {
    return "challenge";
  }

  if (details.status < 200 || details.status >= 300) {
    return "unrecognized_response";
  }

  if (details.body.trim().length === 0) {
    return "empty_response";
  }

  if (!isHtmlResponse(details.contentType) || !hasNextData(details.body)) {
    return "changed_structure";
  }

  return null;
}

export function hasNextData(html: string): boolean {
  return /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>/i.test(html);
}

export function safeOtodomResponsePreview(body: string): string {
  return body
    .slice(0, 480)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\b\d{6,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function otodomSearchErrorMessage(kind: OtodomSearchFailureKind): string {
  switch (kind) {
    case "forbidden":
    case "rate_limited":
    case "security_redirect":
    case "challenge":
      return OTODOM_AUTOMATION_BLOCKED_MESSAGE;
    case "timeout":
      return "Przekroczono limit czasu połączenia z Otodom. Spróbuj ponownie później.";
    case "dns":
    case "connection":
      return "Nie udało się połączyć z Otodom. Spróbuj ponownie później.";
    case "empty_response":
      return "Otodom zwrócił pustą odpowiedź. Spróbuj ponownie później.";
    case "changed_structure":
      return "Otodom zwrócił odpowiedź w zmienionej, nieobsługiwanej strukturze.";
    case "unrecognized_response":
      return "Otodom zwrócił nierozpoznawalną odpowiedź.";
  }
}

function isHtmlResponse(contentType: string): boolean {
  return contentType.toLowerCase().includes("text/html");
}

function isSecurityUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const isOtodomHost =
      url.hostname === "otodom.pl" || url.hostname.endsWith(".otodom.pl");

    return (
      !isOtodomHost ||
      /captcha|challenge|verify|security|access-denied|blocked/i.test(url.pathname)
    );
  } catch {
    return true;
  }
}

function isChallengeHtml(html: string): boolean {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return (
    /just a moment|access denied|verify you are human/i.test(title) ||
    /__cf_chl_|cf-chl-(?:captcha|managed-challenge)|challenge-platform/i.test(html) ||
    /datadome[^<]{0,120}(?:captcha|challenge)|(?:px-captcha|perimeterx)/i.test(html) ||
    /<form[^>]+(?:captcha|g-recaptcha|h-captcha)[^>]*>/i.test(html)
  );
}

function errorDetails(error: unknown): ErrorWithCode {
  if (!error || typeof error !== "object") {
    return {};
  }

  const direct = error as ErrorWithCode;

  if (direct.cause && typeof direct.cause === "object") {
    const cause = direct.cause as ErrorWithCode;
    return {
      name: cause.name ?? direct.name,
      code: cause.code ?? direct.code,
    };
  }

  return direct;
}
