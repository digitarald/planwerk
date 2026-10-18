import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const state = {
  effects: [] as Array<() => void>,
  host: "ws://a",
  changes: [] as Array<{ kind: string; id?: string }>,
  liveConnections: 0,
  initStarts: [] as number[],
  hideDone: true,
};
const key = "__planwerkLiveSessionsTest";
Object.defineProperty(globalThis, key, { value: state, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const originalEventSource = globalThis.EventSource;
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: string }) => void;
  closed = false;
  readonly url: string;
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true });
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const s = `globalThis["${key}"]`;
    let source: string | undefined;
    if (specifier === "react") source = `export function useRef(value){return {current:value};} export function useEffect(effect){const cleanup=effect();if(cleanup) ${s}.effects.push(cleanup);}`;
    if (specifier === "@/lib/store/board-store") source = `
      const state={cards:[],workspaceFilters:new Set(),get hideDone(){return ${s}.hideDone;},
        setArchivedCount(){},
        setCards(cards){state.cards=cards;${s}.changes.push({kind:"init",id:cards[0]?.id});},
        replaceCard(id){${s}.changes.push({kind:"replace",id});},
        addCard(card){state.cards.push(card);${s}.changes.push({kind:"add",id:card.id});},
        removeCard(id){state.cards=state.cards.filter(card=>card.id!==id);${s}.changes.push({kind:"remove",id});},
        getCard(id){return state.cards.find(card=>card.id===id);}};
      export const useBoardStore=selector=>selector(state);
      useBoardStore.getState=()=>state;`;
    if (specifier === "@/lib/store/connection-store") source = `
      export function useConnectionStore(selector){return selector({status:"connected",hostUrl:${s}.host,
      setConnected(){${s}.liveConnections++;},setError(){${s}.changes.push({kind:"error"});}});}`;
    if (specifier === "@/lib/store/inbox-store") source = "export const useInboxStore={getState(){return {reconcileItem(){},removeItem(){}};}};";
    if (specifier === "@/lib/store/orchestrator-store") source = "export function useOrchestratorStore(selector){return selector({addFeedItem(){},setMonitoringStatus(){}});}";
    if (specifier === "@/lib/diagnostics/ui-performance-client") source = `
      export function uiElapsed(name,start){if(name==="sse.init") ${s}.initStarts.push(start);}
      export function uiMark(){}
      export function uiSpan(){return ()=>{};}
      export function uiMeasure(name,work){return work();}`;
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const file = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(file)) return { shortCircuit: true, url: pathToFileURL(file).href };
    }
    return nextResolve(specifier, context);
  },
});
after(() => {
  for (const cleanup of state.effects.splice(0)) cleanup();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
  if (originalEventSource === undefined) Reflect.deleteProperty(globalThis, "EventSource");
  else Object.defineProperty(globalThis, "EventSource", { value: originalEventSource, configurable: true });
});
const { useLiveSessions } = await import("./use-live-sessions.ts");

test("host switch and stream retirement fence delayed snapshots and removal resurrection", () => {
  useLiveSessions();
  const a = FakeEventSource.instances.at(-1)!;
  a.emit({ type: "init", epoch: "a", sequence: 1, cached: true, cards: [{ id: "a" }] });
  assert.equal(state.liveConnections, 0);
  a.emit({ type: "cardRemoved", epoch: "a", sequence: 2, cardId: "a" });
  a.emit({ type: "cardChanged", epoch: "a", sequence: 1, card: { id: "a" } });
  assert.deepEqual(state.changes, [{ kind: "init", id: "a" }, { kind: "remove", id: "a" }]);
  state.effects.pop()!();
  state.host = "ws://b";
  useLiveSessions();
  const b = FakeEventSource.instances.at(-1)!;
  b.emit({ type: "init", epoch: "b", sequence: 1, cards: [{ id: "b" }] });
  assert.equal(state.liveConnections, 1);
  a.emit({ type: "init", epoch: "a", sequence: 3, cards: [{ id: "old" }] });
  a.onerror?.();
  assert.equal(state.changes.at(-1)?.id, "b");
  assert.equal(b.closed, false);
  assert.equal(state.changes.some((change) => change.kind === "error"), false);
});

test("reconnect init timing starts at the stream drop, including reconnect wait", (t) => {
  for (const cleanup of state.effects.splice(0)) cleanup();
  state.initStarts.length = 0;
  let now = 100;
  t.mock.method(performance, "now", () => now);
  useLiveSessions();
  const stream = FakeEventSource.instances.at(-1)!;
  now = 150;
  stream.onopen?.();
  now = 180;
  stream.emit({ type: "init", epoch: "first", sequence: 1, cards: [] });
  now = 1000;
  stream.onerror?.();
  now = 1100;
  stream.onopen?.();
  now = 1200;
  stream.emit({ type: "init", epoch: "reconnected", sequence: 1, cards: [] });
  assert.deepEqual(state.initStarts, [100, 1000]);
  assert.equal(stream.closed, false);
});

test("archive snapshots merge with active cards and removals cannot delete the other view", () => {
  for (const cleanup of state.effects.splice(0)) cleanup();
  state.changes.length = 0;
  state.hideDone = false;
  useLiveSessions();
  const [primary, archive] = FakeEventSource.instances.slice(-2);
  assert.equal(primary.url.includes("view=archived"), false);
  assert.equal(archive.url.includes("view=archived"), true);
  const activeCard = { id: "active", isArchived: false };
  const archivedCard = { id: "archived", isArchived: true };
  archive.emit({ type: "init", epoch: "archive", sequence: 1, cards: [archivedCard] });
  primary.emit({ type: "init", epoch: "active", sequence: 1, cards: [activeCard] });
  primary.emit({ type: "cardRemoved", epoch: "active", sequence: 2, cardId: "archived" });
  archive.emit({ type: "cardRemoved", epoch: "archive", sequence: 2, cardId: "active" });
  assert.equal(state.changes.some((change) => change.kind === "remove"), false);
  archive.emit({ type: "cardRemoved", epoch: "archive", sequence: 3, cardId: "archived" });
  primary.emit({ type: "cardRemoved", epoch: "active", sequence: 3, cardId: "active" });
  assert.deepEqual(state.changes.filter((change) => change.kind === "remove").map((change) => change.id), ["archived", "active"]);
  state.hideDone = true;
});
