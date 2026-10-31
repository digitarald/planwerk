import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import type { InboxItem } from "./inbox-store.ts";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/automation-scope") {
      return { shortCircuit: true, url: 'data:text/javascript,export const UNASSIGNED_WORKSPACE = "unassigned";' };
    }
    return nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());
const { filterInboxItemsByWorkspace, useInboxStore } = await import("./inbox-store.ts");
function item(): InboxItem {
  return {
    id: "inbox", cardId: "archived", sourceKind: "pending-input", category: "action",
    priorityBand: 3, priorityScore: 300, workflowState: "open", readAt: null,
    title: "Generated headline", sessionTitle: "Source session",
    projectName: "Project", workspacePath: "/project", priorityReasons: [],
    briefing: {
      message: "Choose", recommendation: "", recommendationReason: "",
      defaultAction: { id: "open", kind: "open-session", label: "Open session" },
      alternativeActions: [], attention: "now", synthesisStatus: "failed",
      outcome: "", trigger: "pending-input-unavailable", caveats: [],
      confidence: "high", freshness: { generatedAt: 1, sourceObservedAt: 42, stale: false },
      provenance: "Agent session",
    },
    evidence: {}, createdAt: 1, updatedAt: 2,
  };
}
test("identity and source observation survive client normalization and workspace filtering without a board card", () => {
  useInboxStore.setState({ items: [] });
  useInboxStore.getState().reconcileItem(item());
  const current = useInboxStore.getState().items[0];
  assert.equal(current.sessionTitle, "Source session");
  assert.equal(current.workspacePath, "/project");
  assert.equal(current.briefing.freshness.sourceObservedAt, 42);
  assert.equal(current.briefing.defaultAction.kind, "open-session");
  assert.deepEqual(filterInboxItemsByWorkspace([current], [], new Set(["/project"])), [current]);
  assert.deepEqual(filterInboxItemsByWorkspace([current], [], new Set(["/other"])), []);
  const legacy = { ...current, workspacePath: undefined, projectName: undefined, sessionTitle: undefined };
  assert.deepEqual(filterInboxItemsByWorkspace([legacy], [], new Set(["unassigned"])), [legacy]);
});
