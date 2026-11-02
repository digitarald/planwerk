import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { ChatInteractivity } from "@microsoft/agent-host-protocol";
import type { KanbanCard } from "../types.ts";

const reactUrl = import.meta.resolve("react");
const stubs = new Map([
  ["@/lib/store/board-store", "export const useBoardStore = select => select({setDetailCard(){}, reconcileCard(){}});"],
  ["@/lib/store/connection-store", "export const useConnectionStore = select => select({hostUrl:null});"],
  ["@/lib/store/orchestrator-store", "export const useOrchestratorStore = select => select({addFeedItem(){}});"],
  ["@/lib/hooks/use-gate-runs", "export const useGateRuns = () => ({runs:[]});"],
  ["@/components/gates/gate-pipeline", "export const GatePipeline = () => null;"],
  ["@/components/orchestrator/coordinator-mode-control", "export const SessionCoordinatorModeControl = () => null;"],
  ["./conversation-controls", `import {createElement as h} from "${reactUrl}";export const ConversationControls = () => h("section", {"aria-label":"Conversation controls"}, "Send instructions");`],
  ["./session-ownership-recovery", "export const SessionOwnershipRecovery = () => null;"],
  ["@/components/ui/dialog", `import {createElement as h,Fragment} from "${reactUrl}";
    export const Dialog = ({children}) => h(Fragment,null,children);
    export const DialogContent = ({children,className}) => h("div",{role:"dialog",className},children);
    export const DialogTitle = ({children,...props}) => h("h2",props,children);
    export const DialogClose = ({children}) => h("button",null,children);`],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = stubs.get(specifier);
    if (stub) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stub)}` };
    if (specifier.startsWith("@/") || (specifier.startsWith(".") && context.parentURL)) {
      const base = specifier.startsWith("@/")
        ? new URL(`../../${specifier.slice(2)}`, import.meta.url)
        : new URL(specifier, context.parentURL);
      const suffix = [".ts", ".tsx"].find((extension) => existsSync(fileURLToPath(base) + extension));
      if (suffix) return nextResolve(base.href + suffix, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx") && !url.includes("/node_modules/")) {
      return {
        shortCircuit: true,
        format: "module",
        source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
        }).outputText,
      };
    }
    return nextLoad(url, context);
  },
});
after(() => hooks.deregister());
const { CardDetailModal } = await import("../../components/board/card-detail-modal.tsx");
const { ConversationControls } = await import("../../components/board/conversation-controls.tsx");
const card: KanbanCard = {
  id: "detail-test", title: "Test session", phase: "build", runtime: "idle",
  gateStatus: "pending", risk: "low", attention: "none", activity: "",
  additions: 2, deletions: 1, filesChanged: 1, modifiedAt: 0,
  planSteps: { total: 0, done: 0 }, lastAgentMessage: "Outcome worth reading.",
  fileChanges: [{ id: "file-1", path: "src/changes.ts", added: 2, removed: 1 }],
};
const render = (overrides: Partial<KanbanCard> = {}) =>
  renderToStaticMarkup(createElement(CardDetailModal, { card: { ...card, ...overrides } }));

test("the response precedes supporting evidence and changes are collapsed initially", () => {
  const html = render();
  assert.ok(html.indexOf("Outcome worth reading.") < html.indexOf("Evidence and automation"));
  assert.match(html, /<details><summary[^>]*>Changes<\/summary>/);
  assert.ok(html.indexOf("Conversation controls") > html.indexOf("Session changes"));
});

test("the composer keeps inspection in its action row instead of a separate toolbar", () => {
  const html = renderToStaticMarkup(createElement(ConversationControls, { card, hostUrl: null, onSent() {} }));
  const form = html.match(/<form[\s\S]*?<\/form>/)?.[0];
  assert.ok(form);
  assert.ok(form.indexOf("<textarea") < form.indexOf("Inspect conversation"));
  assert.equal((html.match(/Inspect conversation/g) ?? []).length, 1);
  assert.match(form, /text-base sm:text-sm/);
});

test("pending decisions retain the complete response, including text beyond the old cutoff", () => {
  const response = "Important context. ".repeat(50) + "Final constraint must remain available.";
  const html = render({
    runtime: "input-needed", lastAgentMessage: response,
    pendingInput: { requestId: "request-1", message: "Proceed?", questions: [] },
  });
  assert.match(html, /Read agent response/);
  assert.match(html, /Final constraint must remain available\./);
  assert.ok(html.indexOf("Awaiting input") < html.indexOf("Evidence and automation"));
});

test("chat changes stay scoped and hidden chats do not leak into the changes disclosure", () => {
  const html = render({
    fileChanges: [], filesChanged: 0,
    chats: [
      { resource: "chat:lead", title: "Lead conversation" },
      { resource: "chat:hidden", title: "Hidden conversation", interactivity: "hidden" as ChatInteractivity.Hidden },
    ],
    chatDetails: {
      "chat:lead": { changesets: [
        { resource: "changes:branch", label: "Branch", changeKind: "branch", status: "ready", files: [{ id: "branch-file", path: "branch-only.ts", added: 1, removed: 0 }] },
      ] },
      "chat:hidden": { changesets: [
        { resource: "changes:hidden", label: "Hidden changes", changeKind: "branch", status: "ready", files: [] },
      ] },
    },
  });
  assert.match(html, /branch-only\.ts/);
  assert.doesNotMatch(html, /Hidden changes|Hidden conversation|Changes \(0\)|Session changes/);
});

test("error recovery leads and plan and review content remain in the document", () => {
  const html = render({
    runtime: "error", runtimeError: { source: "turn", errorType: "test", message: "Turn failed.", resumable: false },
    artifacts: [
      { id: "plan", type: "plan", title: "Plan", status: "draft", createdAt: 0, createdBy: "agent", contentRef: "Original scope remains inspectable." },
      { id: "review", type: "review", title: "Independent review", status: "approved", createdAt: 0, createdBy: "agent", contentRef: "Reviewer findings remain inspectable." },
    ],
  });
  assert.ok(html.indexOf("Turn failed.") < html.indexOf("Outcome worth reading."));
  assert.match(html, /Original scope remains inspectable/);
  assert.match(html, /Reviewer findings remain inspectable/);
});
