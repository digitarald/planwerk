import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");
const { outputText } = transpileModule(source, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: false },
});

async function desktop(stop: () => Promise<void> = async () => {}) {
  const events = new EventEmitter();
  const processEvents = new EventEmitter();
  const order: string[] = [];
  const errors: unknown[][] = [];
  const messages: unknown[] = [];
  const windows: Window[] = [];
  const health: Health[] = [];
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
    webview = { id: this.id, executeJavascript() {}, loadURL() {} };
    constructor(options: { url: string; frame: Window["frame"] }) {
      this.url = options.url;
      this.frame = options.frame;
      windows.push(this);
    }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    getFrame() { return this.frame; }
    unminimize() { this.minimized = false; }
    show() { this.visible = true; }
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
      Tray: class {
        id = 1;
        on() {}
        setTitle() {}
        setMenu() {}
        remove() { order.push("tray:remove"); }
      },
      ApplicationMenu: { setApplicationMenu() {}, on() {} },
      Utils: {
        quit() {
          order.push("native:quit");
          const event = { response: { allow: true } };
          events.emit("before-quit", event);
          return event.response.allow;
        },
        async showMessageBox(value: unknown) { messages.push(value); return { response: 0 }; },
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
      claimInstance: async () => ({
        close(callback: () => void) { order.push("instance:close"); callback(); },
      }),
    },
    "./model.ts": { menuPresentation: () => ({}), navigationUrl: () => null, externalUrl: () => null },
    "./titlebar.ts": { titlebarPreload: "", titlebarAction: () => null },
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
    setTimeout: () => 1,
    clearTimeout() {},
    console: {
      info(message: string) {
        if (message.includes("Shutdown complete")) order.push("shutdown:complete");
      },
      warn() {},
      error: (...args: unknown[]) => errors.push(args),
    },
  });
  await setImmediate();
  return { events, order, errors, messages, windows, health, starts: () => starts };
}

test("red button vetoes immediate close and waits for owned resources before native quit", async () => {
  let finish!: () => void;
  const app = await desktop(() => new Promise<void>((resolve) => { finish = resolve; }));
  const close = { response: { allow: true } };
  app.events.emit("will-close-1", close);
  app.events.emit("will-close-1", { response: { allow: true } });
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
  app.events.emit("will-close-1", { response: { allow: true } });
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
  app.windows[0].frame = { x: 50, y: 80, width: 900, height: 600 };
  app.health[0].finish(false);
  await setImmediate();
  assert.equal(app.windows.length, 2);
  assert.deepEqual(app.windows[1].frame, app.windows[0].frame);
  assert.equal(app.starts(), 1);
  assert.deepEqual(app.order, ["window:close"]);
  assert.equal(app.events.listenerCount("host-message-1"), 0);
  assert.equal(app.events.listenerCount("will-close-1"), 0);
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
