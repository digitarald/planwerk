import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { isFrame, restoreFrame, type Preferences } from "./preferences.ts";

const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
const { outputText } = transpileModule(source, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: false },
});

async function desktop(stop: () => Promise<void> = async () => {}, saved: Preferences = { zoom: 100 }) {
  const events = new EventEmitter();
  const processEvents = new EventEmitter();
  const order: string[] = [];
  const errors: unknown[][] = [];
  const messages: unknown[] = [];
  const windows: Window[] = [];
  const health: Health[] = [];
  const savedPreferences: Preferences[] = [];
  const preferences = { value: saved, update(value: Preferences) { this.value = value; }, flush() { savedPreferences.push(this.value); } };
  const menuHandlers = new Map<string, (event: unknown) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  type MenuItem = { label?: string; action?: string; accelerator?: string; enabled?: boolean; submenu?: MenuItem[] };
  let menu: MenuItem[] = [];
  let activateInstance: () => void = () => {};
  let response = 0;
  let starts = 0;
  class Health {
    private resolve!: (value: boolean | null) => void;
    private pending = new Promise<boolean | null>((resolve) => { this.resolve = resolve; });
    constructor() { health.push(this); }
    check() { return this.pending; }
    receive() {}
    cancel() { this.resolve(null); }
    finish(value: boolean) { this.resolve(value); }
  }
  class Window {
    id = windows.length + 1;
    url: string;
    frame: { x?: number; y?: number; width: number; height: number };
    minimized = false;
    visible = true;
    fullscreen = false;
    maximized = false;
    zoom = 1;
    scripts: string[] = [];
    loads = 0;
    webview = {
      id: this.id,
      executeJavascript: (script: string) => { this.scripts.push(script); },
      loadURL: () => { this.loads++; this.zoom = 1; },
    };
    constructor(options: { url: string; frame: Window["frame"] }) {
      this.url = options.url;
      this.frame = options.frame;
      windows.push(this);
    }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullscreen; }
    setFullScreen(value: boolean) { this.fullscreen = value; }
    setPageZoom(value: number) { this.zoom = value; }
    getFrame() { return this.frame; }
    unminimize() { this.minimized = false; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    activate() {}
    close() {
      order.push("window:close");
      events.emit(`close-${this.id}`, { data: { id: this.id } });
    }
  }
  const modules: Record<string, unknown> = {
    "electrobun/main": {
      default: { events }, BrowserWindow: Window,
      BuildConfig: { getSync: () => ({ channel: "stable" }) },
      PATHS: { RESOURCES_FOLDER: "/fixture" },
      Screen: { getAllDisplays: () => [{ isPrimary: true, workArea: { x: 0, y: 25, width: 1440, height: 900 } }] },
      Tray: class {
        id = 1;
        on() {}
        setTitle() {}
        setMenu() {}
        remove() { order.push("tray:remove"); }
      },
      ApplicationMenu: {
        setApplicationMenu(value: MenuItem[]) { menu = value; },
        on(name: string, handler: (event: unknown) => void) { menuHandlers.set(name, handler); },
      },
      Utils: {
        quit() {
          order.push("native:quit");
          const event = { response: { allow: true } };
          events.emit("before-quit", event);
          return event.response.allow;
        },
        async showMessageBox(value: unknown) { messages.push(value); return { response }; },
      },
    },
    "node:fs": { mkdirSync() {} },
    "node:os": { homedir: () => "/fixture" },
    "node:path": { join: (...parts: string[]) => parts.join("/") },
    "./backend.ts": {
      Backend: class {
        origin = "http://127.0.0.1:43127";
        async start() { starts++; }
        async stop() { order.push("backend:stop"); await stop(); order.push("backend:stopped"); }
        async status() { return { unread: 0, open: 0, connected: true, running: 0 }; }
      },
    },
    "./instance.ts": {
      claimInstance: async (_path: string, activate: () => void) => {
        activateInstance = activate;
        return {
        close(callback: () => void) { order.push("instance:close"); callback(); },
        };
      },
    },
    "./model.ts": { menuPresentation: () => ({}), navigationUrl: () => null, externalUrl: () => null },
    "./titlebar.ts": { titlebarPreload: "", titlebarAction: () => null, titlebarZoom: () => "" },
    "./preferences.ts": { DesktopPreferences: class { constructor() { return preferences; } }, isFrame, restoreFrame },
    "./diagnostics.ts": {
      createDesktopDiagnostics: () => ({ runId: "fixture", native: { write() {} }, webview: { write() {} } }),
    },
    "./diagnostics-export.ts": {},
    "./webview-diagnostics.ts": { webviewDiagnosticsPreload: "", createWebviewDiagnosticHandler: () => () => {} },
    "./webview-performance.ts": { createWebviewPerformanceHandler: () => () => {} },
    "./renderer-health.ts": { RendererHealth: Health },
    "../electrobun.config.ts": { default: { app: { version: "fixture" } } },
    "../.hutch/devkit/api/sdks/main/proc/native": {},
  };
  await runInNewContext(`(async () => { ${outputText}\n })()`, {
    exports: {},
    require(name: string) {
      assert.ok(name in modules, `Unexpected import: ${name}`);
      return modules[name];
    },
    process: Object.assign(processEvents, { env: {} }),
    performance,
    setTimeout: (callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id: number) => { timers.delete(id); },
    console: {
      info(message: string) {
        if (message.includes("Shutdown complete")) order.push("shutdown:complete");
      },
      warn() {},
      error: (...args: unknown[]) => errors.push(args),
    },
  });
  await setImmediate();
  return {
    events, order, errors, messages, windows, health, preferences, savedPreferences, activateInstance,
    starts: () => starts,
    menu: () => menu.flatMap((item) => item.submenu ?? []),
    respond(value: number) { response = value; },
    action(command: string) { menuHandlers.get("application-menu-clicked")!({ data: { action: command } }); },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("red close and Close Window hide without stopping resources; all reopen paths reuse the window", async () => {
  const app = await desktop();
  const close = { response: { allow: true } };
  app.events.emit("will-close-1", close);
  assert.equal(close.response.allow, false);
  assert.equal(app.windows[0].visible, false);
  assert.deepEqual(app.order, []);
  assert.ok(app.windows[0].scripts.at(-1)?.includes("__PLANWERK_MONITOR_VISIBLE__ = false"));
  app.health[0].finish(false);
  await setImmediate();
  assert.equal(app.windows.length, 1);
  for (const reopen of [() => app.events.emit("reopen"), app.activateInstance, () => app.action("board")]) {
    app.windows[0].minimized = true;
    reopen();
    assert.equal(app.windows[0].visible, true);
    assert.equal(app.windows[0].minimized, false);
    assert.equal(app.windows.length, 1);
    app.action("close");
    assert.equal(app.windows[0].visible, false);
  }
  assert.equal(app.starts(), 1);
});

test("explicit quit vetoes immediate native exit and waits for owned resources", async () => {
  let finish!: () => void;
  const app = await desktop(() => new Promise<void>((resolve) => { finish = resolve; }));
  const close = { response: { allow: true } };
  app.events.emit("before-quit", close);
  app.action("quit");
  assert.equal(close.response.allow, false);
  assert.deepEqual(app.order, ["backend:stop"]);
  finish();
  await setImmediate();
  assert.deepEqual(app.order, [
    "backend:stop", "backend:stopped", "instance:close", "tray:remove", "shutdown:complete", "native:quit",
  ]);
  assert.equal(app.messages.length, 0);
});

test("failed shutdown stays open, reports the error, and allows another quit attempt", async () => {
  let attempts = 0;
  const app = await desktop(async () => {
    if (++attempts === 1) throw new Error("Owned server did not stop");
  });
  app.action("quit");
  await setImmediate();
  assert.deepEqual(app.order, ["backend:stop"]);
  assert.equal(app.messages.length, 1);
  assert.equal(app.errors.length, 1);
  app.events.emit("before-quit", { response: { allow: true } });
  await setImmediate();
  assert.equal(app.order.at(-1), "native:quit");
  assert.equal(attempts, 2);
});

test("renderer recovery preserves the frame, cleans old listeners, and never restarts the server", async () => {
  const app = await desktop();
  const frame = { x: -1200, y: -200, width: 900, height: 600 };
  app.events.emit("resize-1", { data: frame });
  app.action("zoom-in");
  app.health[0].finish(false);
  await setImmediate();
  assert.equal(app.windows.length, 2);
  assert.deepEqual({ ...app.windows[1].frame }, frame);
  assert.equal(app.windows[1].zoom, 1.1);
  assert.equal(app.starts(), 1);
  assert.deepEqual(app.order, ["window:close"]);
  assert.equal(app.events.listenerCount("host-message-1"), 0);
  assert.equal(app.events.listenerCount("will-close-1"), 0);
  assert.equal(app.events.listenerCount("move-1"), 0);
  assert.equal(app.events.listenerCount("host-message-2"), 1);
  app.events.emit("reopen");
  app.health[1].finish(false);
  await setImmediate();
  assert.equal(app.messages.length, 1);
  assert.equal(app.errors.length, 1);
  app.events.emit("reopen");
  await setImmediate();
  assert.equal(app.windows.length, 2);
  assert.equal(app.messages.length, 1);
});

test("minimized windows do not get replaced after a missed renderer acknowledgement", async () => {
  const app = await desktop();
  app.windows[0].minimized = true;
  app.health[0].finish(false);
  await setImmediate();
  assert.equal(app.windows.length, 1);
  assert.equal(app.messages.length, 0);
});

test("zoom is native, bounded, and reapplied after navigation and backend restart", async () => {
  const app = await desktop(async () => {}, { zoom: 150 });
  const win = app.windows[0];
  assert.equal(win.zoom, 1.5);
  assert.equal(app.menu().find((item) => item.action === "zoom-in")?.enabled, true);
  for (let i = 0; i < 10; i++) app.action("zoom-in");
  assert.equal(win.zoom, 2);
  assert.equal(app.menu().find((item) => item.action === "zoom-in")?.enabled, false);
  for (let i = 0; i < 20; i++) app.action("zoom-out");
  assert.equal(win.zoom, 0.5);
  assert.equal(app.menu().find((item) => item.action === "zoom-out")?.enabled, false);
  app.events.emit("dom-ready-1");
  assert.equal(win.zoom, 0.5);
  app.action("zoom-reset");
  assert.equal(win.zoom, 1);
  assert.equal(app.menu().find((item) => item.action === "zoom-reset")?.enabled, false);
  assert.equal(win.loads, 0);
  app.action("zoom-in");
  app.respond(1);
  app.action("restart");
  await setImmediate();
  assert.equal(app.starts(), 2);
  assert.equal(win.loads, 1);
  assert.equal(win.zoom, 1.1);
  app.action("close");
  assert.equal(app.savedPreferences.at(-1)?.zoom, 110);
});

test("view destinations use hashes without reload; fullscreen and maximization preserve normal geometry", async () => {
  const app = await desktop();
  const win = app.windows[0];
  for (const destination of ["inbox", "board", "split", "flightdeck"]) {
    app.action(destination);
    assert.equal(win.scripts.at(-1), `location.hash = "${destination}";`);
  }
  const normal = { x: -1200, y: -100, width: 1000, height: 700 };
  app.events.emit("resize-1", { data: normal });
  app.action("fullscreen");
  assert.equal(win.fullscreen, true);
  app.events.emit("resize-1", { data: { x: 0, y: 0, width: 1440, height: 900 } });
  app.action("close");
  assert.deepEqual({ ...app.savedPreferences.at(-1)?.normalFrame }, normal);
  app.action("fullscreen");
  assert.equal(win.fullscreen, false);
  app.events.emit("resize-1", { data: normal });
  win.maximized = true;
  app.events.emit("resize-1", { data: { x: 0, y: 25, width: 1440, height: 875 } });
  app.action("close");
  assert.deepEqual({ ...app.savedPreferences.at(-1)?.normalFrame }, normal);
  assert.equal(win.loads, 0);
});
