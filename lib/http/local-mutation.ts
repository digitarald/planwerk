function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";
}

type LocalRequest = Pick<Request, "method" | "url" | "headers">;

function validateStrictLocalRequest(
  request: LocalRequest,
  expectedMethod: "GET" | "POST" | "DELETE",
): string | null {
  if (request.method !== expectedMethod) {
    return `request requires ${expectedMethod}`;
  }

  const host = request.headers.get("host");
  let requestUrl: URL;
  let originUrl: URL;
  let hostUrl: URL;
  try {
    requestUrl = new URL(request.url);
    originUrl = new URL(request.headers.get("origin") ?? "");
    hostUrl = new URL(`http://${host ?? ""}`);
  } catch {
    return "valid Origin, Host, and request URL are required";
  }

  if (
    !host ||
    requestUrl.protocol !== "http:" ||
    originUrl.protocol !== "http:" ||
    hostUrl.protocol !== "http:" ||
    hostUrl.host !== host ||
    originUrl.host !== host ||
    !isLoopbackHostname(hostUrl.hostname) ||
    !isLoopbackHostname(requestUrl.hostname)
  ) {
    return "request Origin and Host must match the local Planwerk server";
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return "cross-origin request is not allowed";
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
  return validateStrictLocalRequest(request, "GET");
}
