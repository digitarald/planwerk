import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const model = {
  cursor: 0, slots: [] as unknown[], effects: [] as Array<() => void>,
  cleanups: [] as Array<() => void>,
};
const key = "__planwerkOwnershipRecoveryUI";
Object.defineProperty(globalThis, key, { value: model, configurable: true });
const root = path.resolve(import.meta.dirname, "../..");
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier === "react") source = `
      const s=globalThis["${key}"];
      export function useState(value){const i=s.cursor++;if(!(i in s.slots))s.slots[i]=value;return [s.slots[i],v=>{s.slots[i]=typeof v==="function"?v(s.slots[i]):v;}];}
      export function useRef(value){const i=s.cursor++;return s.slots[i]??=( {current:value} );}
      export function useEffect(effect,deps){const i=s.cursor++;const prior=s.slots[i];if(!prior||JSON.stringify(prior)!==JSON.stringify(deps)){s.slots[i]=deps;s.effects.push(()=>{const cleanup=effect();if(cleanup)s.cleanups.push(cleanup);});}}`;
    if (specifier === "react/jsx-runtime") source = "export function jsx(type,props){return {type,props};}export const jsxs=jsx;export const Fragment='fragment';";
    if (specifier === "@/components/ui/button") source = "export function Button(){}";
    if (source) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` };
    if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(path.join(root, `${specifier.slice(2)}.ts`)).href };
    if (specifier.startsWith(".") && !path.extname(specifier) && context.parentURL?.startsWith("file:")) {
      const file = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (existsSync(file)) return { shortCircuit: true, url: pathToFileURL(file).href };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/session-ownership-recovery.tsx")) return {
      shortCircuit: true, format: "module",
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
after(() => { hooks.deregister(); Reflect.deleteProperty(globalThis, key); });
const { SessionOwnershipRecovery } = await import("../../components/board/session-ownership-recovery.tsx");
const diagnostic = {
  sessionUri: "a", quarantined: true, revision: 7,
  owner: { hostId: "one", label: "VS Code local" },
  conflictingHost: { hostId: "two", label: "ws://localhost:4000" },
  hosts: [{ hostId: "one", label: "VS Code local" }, { hostId: "two", label: "ws://localhost:4000" }],
};
interface Element { type: unknown; props: Record<string, unknown> }
function nodes(tree: unknown): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const node = tree as Element;
  return [node, ...nodes(node.props.children)];
}
function render() {
  model.cursor = 0;
  const tree = SessionOwnershipRecovery({ sessionUri: "a" });
  for (const effect of model.effects.splice(0)) effect();
  return nodes(tree);
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function reset() { for (const cleanup of model.cleanups.splice(0)) cleanup(); model.slots = []; model.effects = []; }
function clickChoice(elements: Element[]) {
  const choice = elements.find((node) => node.props.value === "two")!;
  (choice.props.onChange as () => void)();
  const checked = render().find((node) => node.props.type === "checkbox")!;
  (checked.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
}

test("recovery requires known-host choice and confirmation, deduplicates submit and never patches the card optimistically", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  let posts = 0;
  let complete!: (response: Response) => void;
  globalThis.fetch = async (_url, options) => {
    if (options?.method !== "POST") return Response.json(diagnostic);
    posts++;
    assert.deepEqual(JSON.parse(options.body as string), { sessionUri: "a", hostId: "two", expectedRevision: 7, confirm: true });
    return new Promise<Response>((resolve) => { complete = resolve; });
  };
  try {
    assert.ok(render().some((node) => node.props.role === "status"));
    await tick();
    const initial = render();
    assert.equal(initial.find((node) => node.props.children === "Confirm host")?.props.disabled, true);
    clickChoice(initial);
    const ready = render().find((node) => node.props.children === "Confirm host")!;
    assert.equal(ready.props.disabled, false);
    const save = ready.props.onClick as () => Promise<void>;
    const first = save();
    await save();
    assert.equal(posts, 1);
    assert.equal(render().find((node) => node.props.children === "Resolving ownership")?.props.disabled, true);
    complete(Response.json({ success: true, ownership: { ...diagnostic, quarantined: false, owner: diagnostic.hosts[1], revision: 8 } }));
    await first;
    assert.equal(render().some((node) => node.props.children === "Confirm host"), false);
  } finally { reset(); globalThis.fetch = originalFetch; }
});

test("a stale or busy recovery explains the refusal and requires reloading before another decision", async () => {
  reset();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => options?.method === "POST"
    ? Response.json({ success: false, reason: "in-flight" }, { status: 409 })
    : Response.json(diagnostic);
  try {
    render();
    await tick();
    clickChoice(render());
    const save = render().find((node) => node.props.children === "Confirm host")!;
    await (save.props.onClick as () => Promise<void>)();
    const result = render();
    assert.match(String(result.find((node) => node.props.role === "alert")?.props.children), /still running or unresolved/);
    assert.equal(result.find((node) => node.props.children === "Confirm host")?.props.disabled, true);
    assert.ok(result.some((node) => node.props.children === "Reload choices"));
  } finally { reset(); globalThis.fetch = originalFetch; }
});
