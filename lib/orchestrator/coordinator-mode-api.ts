import type { CoordinatorModeStore } from "../db/coordinator-mode-store.ts";
import {
  isCoordinatorMode,
  type CoordinatorMode,
} from "./coordinator-mode.ts";
import { validateLocalMutationRequest } from "../http/local-mutation.ts";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function parseCardIds(searchParams: URLSearchParams): {
  cardIds: string[] | undefined;
  error: string | null;
} {
  if (!searchParams.has("cardIds")) {
    return { cardIds: undefined, error: null };
  }

  // Accept both repeated cardIds parameters and comma-separated values so
  // callers can use URLSearchParams.append or one compact query parameter.
  const cardIds = searchParams
    .getAll("cardIds")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim());
  if (cardIds.some((cardId) => cardId.length === 0)) {
    return { cardIds: undefined, error: "cardIds must be non-empty" };
  }
  return { cardIds: [...new Set(cardIds)], error: null };
}

function modeState(
  store: CoordinatorModeStore,
  filters: {
    hostUrl?: string;
    cardIds?: readonly string[];
  },
) {
  const boardDefault = store.getBoardDefault();
  const overrides = store.listSessionOverrides(filters);
  const effectiveModes = filters.hostUrl && filters.cardIds
    ? filters.cardIds.map((cardId) =>
        store.getEffectiveMode(filters.hostUrl!, cardId)
      )
    : overrides.map((override) => ({
        ...override,
        source: "session" as const,
      }));
  return { boardDefault, overrides, effectiveModes };
}

export function handleCoordinatorModeGet(
  request: Request,
  store: CoordinatorModeStore,
): Response {
  const searchParams = new URL(request.url).searchParams;
  const rawHostUrl = searchParams.get("hostUrl");
  const hostUrl = rawHostUrl?.trim();
  if (rawHostUrl !== null && !hostUrl) {
    return json({ error: "hostUrl must be non-empty" }, 400);
  }
  const parsedCardIds = parseCardIds(searchParams);
  if (parsedCardIds.error) {
    return json({ error: parsedCardIds.error }, 400);
  }

  return json(modeState(store, {
    ...(hostUrl ? { hostUrl } : {}),
    ...(parsedCardIds.cardIds ? { cardIds: parsedCardIds.cardIds } : {}),
  }));
}

export async function handleCoordinatorModePost(
  request: Request,
  store: CoordinatorModeStore,
): Promise<Response> {
  const requestError = validateLocalMutationRequest(request);
  if (requestError) return json({ error: requestError }, 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid coordinator mode body" }, 400);
  }

  const values = body as Record<string, unknown>;
  if (values.scope === "board") {
    if (
      Object.keys(values).some((key) => key !== "scope" && key !== "mode") ||
      !isCoordinatorMode(values.mode)
    ) {
      return json(
        { error: "board scope requires a valid coordinator mode" },
        400,
      );
    }
    store.setBoardDefault(values.mode);
    return json({
      scope: "board",
      ...modeState(store, {}),
    });
  }

  if (values.scope === "session") {
    if (
      Object.keys(values).some((key) =>
        key !== "scope" &&
        key !== "hostUrl" &&
        key !== "cardId" &&
        key !== "mode"
      ) ||
      typeof values.hostUrl !== "string" ||
      !values.hostUrl.trim() ||
      typeof values.cardId !== "string" ||
      !values.cardId.trim() ||
      (values.mode !== null && !isCoordinatorMode(values.mode))
    ) {
      return json(
        {
          error:
            "session scope requires non-empty hostUrl/cardId and a valid mode or null",
        },
        400,
      );
    }
    const hostUrl = values.hostUrl.trim();
    const cardId = values.cardId.trim();
    store.setSessionOverride(
      hostUrl,
      cardId,
      values.mode as CoordinatorMode | null,
    );
    return json({
      scope: "session",
      ...modeState(store, { hostUrl, cardIds: [cardId] }),
    });
  }

  return json({ error: "scope must be board or session" }, 400);
}
