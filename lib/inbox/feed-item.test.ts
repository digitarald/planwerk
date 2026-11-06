import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { KanbanCard } from "../types.ts";
import type { InboxApiItem, InboxItem } from "./types.ts";
import { serializeInboxItem } from "./contract.ts";

const state: { cards: Partial<KanbanCard>[]; connected: boolean } = { cards: [], connected: true };
const key = "__planwerkInboxFeedTest";
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const reactUrl = import.meta.resolve("react");
const stubs = new Map([
  ["@/lib/store/board-store", `export const useBoardStore = select => select({cards:globalThis["${key}"].cards,setDetailCard(){}});`],
  ["@/lib/store/connection-store", `export const useConnectionStore = select => select({status:globalThis["${key}"].connected?"connected":"disconnected"});`],
  ["@/lib/store/inbox-store", "export const useInboxStore = select => select({pendingIds:new Set(),selectItem(){},mutateItem(){}});"],
  ["@/lib/store/ui-store", "export const useUIStore = select => select({setWorkspaceMode(){}});"],
  ["@/components/board/artifact-viewer", "export const ArtifactViewer = () => null;"],
  ["@/components/ui/button", `import {createElement as h} from "${reactUrl}";export const Button = ({children,size,variant,...props}) => h("button",props,children);`],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = stubs.get(specifier);
    if (stub) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stub)}` };
    if (specifier.startsWith("@/")) {
      const base = new URL(`../../${specifier.slice(2)}`, import.meta.url);
      const suffix = [".ts", ".tsx"].find((extension) => existsSync(fileURLToPath(base) + extension));
      if (suffix) return nextResolve(base.href + suffix, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/components/inbox/inbox-feed-item.tsx")) return {
      shortCircuit: true, format: "module",
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });
const { InboxFeedItem } = await import("../../components/inbox/inbox-feed-item.tsx");
const observed = "2026-11-06T18:00:00.000Z";
const notice: InboxItem = {
  id: "notice", sourceKey: "source", sourceRevision: "event-revision",
  kind: "gate-failure", priorityBand: "high", priorityRank: 300,
  workflowState: "open", readState: "unread", cardId: "session", relatedCardIds: [],
  title: "Check failed", createdAt: observed, updatedAt: observed,
  readAt: null, resolvedAt: null, pinnedAt: null, snoozedUntil: null,
  briefing: {
    reason: "Lint failed", recommendation: "", alternativeActions: [], outcome: "",
    caveats: [], confidence: "high",
    freshness: { observedAt: observed, sourceObservedAt: observed },
    provenance: { sourceType: "orchestrator", sourceKey: "source", eventType: "gate-completed", sessionTitle: "Known session" },
  },
};
const render = (overrides: Partial<InboxApiItem> = {}) => renderToStaticMarkup(createElement(InboxFeedItem, {
  item: { ...serializeInboxItem(notice), ...overrides }, selected: false, now: Date.parse(observed),
}));

test("off-board notices retain identity without claiming the source session is gone", () => {
  state.cards = [];
  state.connected = true;
  const html = render();
  assert.match(html, /Known session/);
  assert.match(html, /Not on this board/);
  assert.doesNotMatch(html, /Session unavailable/);
});

test("disconnection takes precedence over off-board availability", () => {
  state.connected = false;
  const html = render();
  assert.match(html, /Disconnected/);
  assert.doesNotMatch(html, /Not on this board|Session unavailable/);
  state.connected = true;
});

test("board-level coordinator notices are not mislabeled as missing sessions", () => {
  const html = render({ cardId: "", sessionTitle: undefined, sourceKind: "coordinator-action" });
  assert.match(html, /Coordinator/);
  assert.doesNotMatch(html, /Not on this board|Session unavailable/);
});
