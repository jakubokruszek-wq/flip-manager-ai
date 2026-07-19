import { PropertyImportError, isPropertyImportError } from "../errors";

const MAX_HTML_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

type FetchListingHtmlOptions = {
  allowsUrl(url: URL): boolean;
};

export type FetchedListingHtml = {
  html: string;
  url: string;
};

/**
 * Pobiera strone ogloszenia po stronie serwera. Kazdy etap przekierowania
 * jest sprawdzany przez adapter, zeby URL nie mogl zmienic sie w dowolne
 * miejsce w sieci.
 */
export async function fetchListingHtml(
  input: URL,
  options: FetchListingHtmlOptions
): Promise<FetchedListingHtml> {
  let currentUrl = new URL(input.href);

  if (!options.allowsUrl(currentUrl)) {
    throw new PropertyImportError(
      "REDIRECT_NOT_ALLOWED",
      "Adres ogłoszenia nie jest dozwolony dla tego importera."
    );
  }

  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      const response = await fetch(currentUrl, {
        cache: "no-store",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "pl-PL,pl;q=0.9",
          "User-Agent": "FlipManagerPropertyImporter/1.0",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      console.log("OTODOM RESPONSE STATUS:", response.status);

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");

        if (!location) {
          throw new PropertyImportError(
            "UNEXPECTED_RESPONSE",
            "Portal zwrócił przekierowanie bez adresu docelowego."
          );
        }

        const nextUrl = new URL(location, currentUrl);

        if (!options.allowsUrl(nextUrl)) {
          throw new PropertyImportError(
            "REDIRECT_NOT_ALLOWED",
            "Przekierowanie poza dozwoloną domenę zostało zablokowane."
          );
        }

        currentUrl = nextUrl;
        continue;
      }

      if (response.status === 404 || response.status === 410) {
        throw new PropertyImportError(
          "LISTING_NOT_FOUND",
          "Ogłoszenie nie istnieje lub nie jest już dostępne."
        );
      }

      if (!response.ok) {
        throw new PropertyImportError(
          "FETCH_FAILED",
          `Portal zwrócił błąd HTTP ${response.status}.`
        );
      }

      const contentType = response.headers.get("content-type") ?? "";

      if (!contentType.toLowerCase().includes("text/html")) {
        throw new PropertyImportError(
          "UNEXPECTED_RESPONSE",
          "Portal nie zwrócił dokumentu HTML."
        );
      }

      return {
        html: await readHtmlWithLimit(response),
        url: currentUrl.href,
      };
    }

    throw new PropertyImportError(
      "FETCH_FAILED",
      "Portal przekierował zapytanie zbyt wiele razy."
    );
  } catch (error) {
    if (isPropertyImportError(error)) {
      throw error;
    }

    throw new PropertyImportError(
      "FETCH_FAILED",
      "Nie udało się pobrać strony ogłoszenia.",
      error
    );
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readHtmlWithLimit(response: Response): Promise<string> {
  const declaredSize = Number(response.headers.get("content-length"));

  if (Number.isFinite(declaredSize) && declaredSize > MAX_HTML_BYTES) {
    throw new PropertyImportError(
      "UNEXPECTED_RESPONSE",
      "Strona ogłoszenia jest zbyt duża do bezpiecznego przetworzenia."
    );
  }

  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let html = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    receivedBytes += value.byteLength;

    if (receivedBytes > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new PropertyImportError(
        "UNEXPECTED_RESPONSE",
        "Strona ogłoszenia jest zbyt duża do bezpiecznego przetworzenia."
      );
    }

    html += decoder.decode(value, { stream: true });
  }

  return html + decoder.decode();
}
