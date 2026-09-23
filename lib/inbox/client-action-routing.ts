import type { InboxActionKind } from "../store/inbox-store.ts";

export type InboxClientActionTarget =
  | { type: "mutation"; action: "read" | "resolve" }
  | { type: "board" }
  | { type: "card" }
  | { type: "unavailable" };

export function routeInboxClientAction(
  trigger: string,
  action: InboxActionKind,
  hasCard: boolean,
): InboxClientActionTarget {
  if (trigger === "wip-violation" && action !== "resolve") {
    return { type: "board" };
  }
  if (action === "mark-read") {
    return { type: "mutation", action: "read" };
  }
  if (action === "resolve") {
    return { type: "mutation", action: "resolve" };
  }
  return hasCard ? { type: "card" } : { type: "unavailable" };
}
