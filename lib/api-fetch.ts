type ApiFetch = typeof globalThis.fetch;

const defaultFetch: ApiFetch = (...args) => globalThis.fetch(...args);

export function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  fetchImplementation: ApiFetch = defaultFetch,
): Promise<Response> {
  return fetchImplementation(input, {
    ...init,
    credentials: init.credentials ?? "same-origin",
  });
}
