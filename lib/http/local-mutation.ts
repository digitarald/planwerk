function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";
}

type LocalRequest = Pick<Request, "method" | "url" | "headers">;

function validateStrictLocalRequest(
  request: LocalRequest,
  expectedMethod: "GET" | "POST" | "DELETE",
  allowOriginlessSameOriginFetch = false,
): string | null {
  if (request.method !== expectedMethod) {
    return `request requires ${expectedMethod}`;
  }

  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  let requestUrl: URL;
  let hostUrl: URL;
  try {
    requestUrl = new URL(request.url);
    hostUrl = new URL(`http://${host ?? ""}`);
  } catch {
    return "valid Host and request URL are required";
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    !host ||
    requestUrl.protocol !== "http:" ||
    hostUrl.protocol !== "http:" ||
    hostUrl.host !== host ||
    !isLoopbackHostname(hostUrl.hostname) ||
    !isLoopbackHostname(requestUrl.hostname)
  ) {
    return "request Origin and Host must match the local Planwerk server";
  }

  if (fetchSite && fetchSite !== "same-origin") {
    return "cross-origin request is not allowed";
  }

  if (!origin) {
    return allowOriginlessSameOriginFetch && fetchSite === "same-origin"
      ? null
      : "valid Origin, Host, and request URL are required";
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return "valid Origin, Host, and request URL are required";
  }
  if (originUrl.protocol !== "http:" || originUrl.host !== host) {
    return "request Origin and Host must match the local Planwerk server";
  }

  return null;
}

export function validateLocalMutationRequest(
  request: Pick<Request, "method" | "url" | "headers">,
  expectedMethod: "POST" | "DELETE" = "POST",
): string | null {
  const localRequestError = validateStrictLocalRequest(request, expectedMethod);
  if (localRequestError) return localRequestError;

  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    ?.toLowerCase();
  if (contentType !== "application/json") {
    return "Content-Type must be application/json";
  }
  return null;
}

export function validateLocalEventStreamRequest(
  request: LocalRequest,
): string | null {
  // Native same-origin EventSource requests can omit Origin. Chromium still
  // supplies Fetch Metadata, so require its same-origin signal in that case.
  return validateStrictLocalRequest(request, "GET", true);
}
