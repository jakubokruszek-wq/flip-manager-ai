export type PropertyImportErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_SOURCE"
  | "REDIRECT_NOT_ALLOWED"
  | "FETCH_FAILED"
  | "LISTING_NOT_FOUND"
  | "UNEXPECTED_RESPONSE"
  | "PARSER_FAILED";

export class PropertyImportError extends Error {
  readonly code: PropertyImportErrorCode;
  readonly cause?: unknown;

  constructor(code: PropertyImportErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "PropertyImportError";
    this.code = code;
    this.cause = cause;
  }
}

export function isPropertyImportError(
  error: unknown
): error is PropertyImportError {
  return error instanceof PropertyImportError;
}
