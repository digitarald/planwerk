import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = await readFile(new URL("../../components/desktop-navigation.tsx", import.meta.url), "utf8");
const { outputText } = transpileModule(source, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
});

test("desktop hashes allow only workspace destinations, consume routes and preserve filters", () => {
  let navigate!: () => void;
  let mode = "split";
  let filter = "all";
  const routes: string[] = [];
  const window = {
    location: { hash: "", pathname: "/board", search: "?host=local" },
    history: { replaceState: (_state: unknown, _title: string, path: string) => routes.push(path) },
    addEventListener: (_name: string, handler: () => void) => { navigate = handler; },
    removeEventListener() {},
  };
  const modules: Record<string, unknown> = {
    react: { useEffect: (effect: () => void) => effect() },
    "@/lib/store/ui-store": { useUIStore: { getState: () => ({ setWorkspaceMode: (value: string) => { mode = value; } }) } },
    "@/lib/store/inbox-store": { useInboxStore: { getState: () => ({ setFilter: (value: string) => { filter = value; } }) } },
  };
  const exports: { DesktopNavigation?: () => void } = {};
  runInNewContext(outputText, { exports, window, require: (name: string) => {
    assert.ok(name in modules, `Unexpected dependency (workspace scope must not change): ${name}`);
    return modules[name];
  } });
  exports.DesktopNavigation!();
  for (const destination of ["inbox", "board", "split", "flightdeck"]) {
    window.location.hash = `#${destination}`;
    navigate();
    assert.equal(mode, destination);
    assert.equal(filter, "unread");
    assert.equal(routes.at(-1), "/board?host=local");
  }
  for (const hash of ["#settings", "#execute", "#zoom", "#BOARD"]) {
    window.location.hash = hash;
    navigate();
  }
  assert.equal(mode, "flightdeck");
  assert.equal(routes.length, 4);
});
