import { foundryConfiguration } from "./config.ts";
import { validateQuestions, validateResponse, type DecisionQuestions } from "./core.ts";

export class DecisionTransportError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

export async function callFoundry(
  state: unknown, questions: DecisionQuestions, signal?: AbortSignal,
) {
  validateQuestions(questions);
  if (!(typeof state === "string" && state.trim()) &&
      !(state && typeof state === "object" && Object.keys(state).length)) {
    throw new Error("Decision state must be nonempty text or JSON evidence.");
  }
  const config = await foundryConfiguration();
  const body = JSON.stringify({ model: config.deployment, state, questions }, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Decision evidence must contain finite numbers.");
    return value;
  });
  if (Buffer.byteLength(body) > 128 * 1024) throw new Error("Decision evidence exceeds the 128 KiB request limit.");
  const response = await fetch(`${config.endpoint}/providers/microsoft/v1/systemone`, {
    method: "POST", redirect: "error", cache: "no-store",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...config.headers },
    body, signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) {
    const retryable = [408, 429].includes(response.status) || response.status >= 500;
    const retryHeader = response.headers.get("retry-after");
    const retryDelay = retryHeader ? /^\d+$/.test(retryHeader)
      ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now() : 30_000;
    await response.body?.cancel();
    throw new DecisionTransportError(`Decision service returned HTTP ${response.status}.`,
      retryable && Number.isSafeInteger(retryDelay) && retryDelay <= 86_400_000
        ? Math.max(retryDelay, 1_000) : undefined);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Decision service returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("Decision response exceeds the 1 MiB limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return validateResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")), questions);
}
