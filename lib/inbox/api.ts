import {
  INBOX_ACTION_TYPES,
  INBOX_ITEM_KINDS,
  type InboxActionType,
  type InboxItemKind,
  type InboxListQuery,
  type InboxReadState,
  type InboxWorkflowState,
} from "./types.ts";
import { isSupportedAhpEndpoint } from "../ahp/endpoint-config.ts";

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseInboxHostUrl(
  value: string | null,
): ParseResult<string | undefined> {
  const hostUrl = value?.trim();
  if (!hostUrl) return { ok: true, value: undefined };
  if (!isSupportedAhpEndpoint(hostUrl)) {
    return {
      ok: false,
      error: "host must be a vscode-local://desktop, ws://, or wss:// AHP endpoint",
    };
  }
  return { ok: true, value: hostUrl };
}

export function parseInboxListQuery(
  searchParams: URLSearchParams,
): ParseResult<InboxListQuery> {
  const workflowState = searchParams.get("state") ?? "all";
  if (!["open", "resolved", "dismissed", "all"].includes(workflowState)) {
    return { ok: false, error: "state must be open, resolved, dismissed, or all" };
  }
  const readState = searchParams.get("read") ?? "all";
  if (!["unread", "read", "all"].includes(readState)) {
    return { ok: false, error: "read must be unread, read, or all" };
  }
  const kind = searchParams.get("kind");
  if (
    kind &&
    !(INBOX_ITEM_KINDS as readonly string[]).includes(kind)
  ) {
    return { ok: false, error: "kind is not a recognized inbox item kind" };
  }
  const rawLimit = searchParams.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    return { ok: false, error: "limit must be an integer from 1 to 500" };
  }
  const cardId = searchParams.get("cardId")?.trim();
  const host = parseInboxHostUrl(searchParams.get("host"));
  if (!host.ok) return host;
  return {
    ok: true,
    value: {
      workflowState: workflowState as InboxWorkflowState | "all",
      readState: readState as InboxReadState | "all",
      kind: kind ? kind as InboxItemKind : undefined,
      cardId: cardId || undefined,
      hostUrl: host.value,
      limit,
    },
  };
}

export function parseInboxActionBody(
  body: unknown,
): ParseResult<{
  action: InboxActionType;
  snoozedUntil: string | null;
}> {
  if (!isRecord(body)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const action = body.action;
  if (
    typeof action !== "string" ||
    !(INBOX_ACTION_TYPES as readonly string[]).includes(action)
  ) {
    return {
      ok: false,
      error: `action must be one of: ${INBOX_ACTION_TYPES.join(", ")}`,
    };
  }
  const unsupportedFields = Object.keys(body).filter(
    (key) => key !== "action" && key !== "snoozedUntil",
  );
  if (unsupportedFields.length > 0) {
    return {
      ok: false,
      error: `unsupported action field: ${unsupportedFields[0]}`,
    };
  }
  let snoozedUntil: string | null = null;
  if (action === "snooze") {
    if (
      typeof body.snoozedUntil !== "number" ||
      !Number.isFinite(body.snoozedUntil) ||
      body.snoozedUntil <= Date.now()
    ) {
      return {
        ok: false,
        error: "snoozedUntil must be a future epoch-millisecond timestamp",
      };
    }
    snoozedUntil = new Date(body.snoozedUntil).toISOString();
  } else if (body.snoozedUntil !== undefined) {
    return {
      ok: false,
      error: "snoozedUntil is only valid for the snooze action",
    };
  }
  return {
    ok: true,
    value: {
      action: action as InboxActionType,
      snoozedUntil,
    },
  };
}
