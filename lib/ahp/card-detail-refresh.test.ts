import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { KanbanCard } from "../types.ts";

const card: KanbanCard = {
  id: "session-1", title: "Test", phase: "build", runtime: "idle", risk: "medium",
  gateStatus: "pending", attention: "none", activity: "", additions: 0, deletions: 0,
  filesChanged: 0, planSteps: { total: 0, done: 0 }, modifiedAt: 0,
};
const state = {
  card, patches: [] as object[], effects: [] as Array<() => (() => void) | void>,
};
const key = "__planwerkDetailRefreshTest";
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const componentUrl = pathToFileURL(path.join(root, "components/board/card-detail-modal.tsx")).href;
const noopComponents = new Set([
  "./pending-input-card", "@/components/ui/badge", "@/components/ui/button",
  "@/components/ui/scroll-area", "@/components/ui/textarea",
  "@/components/gates/gate-pipeline", "@/components/orchestrator/coordinator-mode-control",
]);
const componentNames = ["PendingInputCard", "Badge", "Button", "ScrollArea", "Textarea", "GatePipeline", "SessionCoordinatorModeControl"];
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const s = `globalThis["${key}"]`;
    let source: string | undefined;
    if (specifier === "react/jsx-runtime") source = "export const Fragment='fragment';export function jsx(type,props){return {type,props};}export const jsxs=jsx;";
    if (specifier === "lucide-react") source = "X Send GitBranch FileText FileEdit FlaskConical Lightbulb BookOpen ClipboardCheck Scale Clock Shield ShieldAlert Loader2 CirclePause AlertTriangle ShieldCheck ShieldX MessageCircleWarning XCircle ChevronDown Split Cpu Bot RotateCcw".split(" ").map((name) => `export function ${name}(){}`).join("\n");
    if (specifier === "react") source = `export function useState(value){return [typeof value==="function"?value():value,()=>{}];} export function useRef(value){return {current:value};} export function useEffect(effect){${s}.effects.push(effect);}`;
    if (specifier === "@/lib/store/board-store") source = `
      const store={setDetailCard(){},updateCard(){},reconcileCard(id,patch){${s}.patches.push(patch);},getCard(){return ${s}.card;}};
      export const useBoardStore=selector=>selector(store);useBoardStore.getState=()=>store;`;
    if (specifier === "@/lib/store/connection-store") source = `export const useConnectionStore=selector=>selector({hostUrl:"ws://fake"});`;
    if (specifier === "@/lib/store/orchestrator-store") source = `export const useOrchestratorStore=selector=>selector({addFeedItem(){}});`;
    if (specifier === "@/lib/ahp/chat-facts") source = "export function canSendToChat(){return true;}";
    if (specifier === "./session-ownership-recovery") source = "export function SessionOwnershipRecovery(){}";
    if (specifier === "@/lib/hooks/use-gate-runs") source = "export function useGateRuns(){return {runs:[]};}";
    if (noopComponents.has(specifier)) source = componentNames.map((name) => `export function ${name}(){}`).join("\n");
    if (specifier === "react-markdown" || specifier === "remark-gfm") source = "export default function(){}";
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) {
      const file = path.join(root, specifier.slice(2));
      return { shortCircuit: true, url: pathToFileURL(existsSync(`${file}.ts`) ? `${file}.ts` : path.join(file, "index.ts")).href };
    }
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const file = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(file)) return { shortCircuit: true, url: pathToFileURL(file).href };
      if (existsSync(`${file}x`)) return { shortCircuit: true, url: pathToFileURL(`${file}x`).href };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === componentUrl || url.endsWith("/session-evidence-panel.tsx")) return {
      shortCircuit: true, format: "module",
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });
const { CardDetailModal } = await import("../../components/board/card-detail-modal.tsx");

function findRefresh(value: unknown): (() => Promise<void>) | undefined {
  if (Array.isArray(value)) {
    for (const child of value) { const found = findRefresh(child); if (found) return found; }
  }
  if (!value || typeof value !== "object" || !("props" in value)) return undefined;
  const props = value.props as { title?: string; onClick?: () => Promise<void>; children?: unknown };
  if (props.title?.startsWith("Read plan, files, and outcome.")) return props.onClick;
  const child = findRefresh(props.children);
  if (child) return child;
  if ("type" in value && typeof value.type === "function") return findRefresh(value.type(props));
  return undefined;
}

test("late modal detail reads cannot overwrite explicitly refreshed stream evidence", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    value: { addEventListener() {}, removeEventListener() {} }, configurable: true,
  });

  let resolveDetails!: (response: Response) => void;
  let detailsSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/status-history")) return Response.json({ entries: [] });
    if (String(url).endsWith("/details")) {
      detailsSignal = options?.signal;
      return new Promise<Response>((resolve) => { resolveDetails = resolve; });
    }
    assert.equal(String(url), "/api/ahp/sessions/evidence");
    state.card = { ...card, lastAgentMessage: "New streamed outcome", sourceRevision: "new" };
    return Response.json({ success: true, session: { resource: card.id } });
  };
  const cleanups: Array<() => void> = [];
  try {
    const tree = CardDetailModal({ card });
    for (const effect of state.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    const refresh = findRefresh(tree);
    assert.ok(refresh);
    await refresh();
    assert.equal(detailsSignal?.aborted, true);
    resolveDetails(Response.json({ details: { lastAgentMessage: "Old HTTP outcome" } }));
    for (let index = 0; index < 3; index++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(state.patches, []);
    assert.equal(state.card.lastAgentMessage, "New streamed outcome");
  } finally {
    for (const cleanup of cleanups) cleanup();
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
  }
});

test("opening an ownership conflict does not subscribe for ambiguous session details", async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    value: { addEventListener() {}, removeEventListener() {} }, configurable: true,
  });
  const requests: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json({ entries: [] });
  };
  const cleanups: Array<() => void> = [];
  try {
    CardDetailModal({ card: { ...card, ownershipConflict: true } });
    for (const effect of state.effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests.some((url) => url.includes("/sessions/details")), false);
    assert.equal(requests.some((url) => url.includes("/sessions/evidence")), false);
  } finally {
    for (const cleanup of cleanups) cleanup();
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
  }
});
