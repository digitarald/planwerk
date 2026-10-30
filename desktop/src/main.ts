import Electrobun, { ApplicationMenu, BrowserWindow, BuildConfig, PATHS, Tray, Utils } from "electrobun/main";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { Backend } from "./backend.ts";
import { claimInstance } from "./instance.ts";
import { externalUrl, menuPresentation, navigationUrl, type DesktopState } from "./model.ts";
import { titlebarAction, titlebarPreload } from "./titlebar.ts";
import { createDesktopDiagnostics } from "./diagnostics.ts";
import { exportDiagnostics } from "./diagnostics-export.ts";
import { createWebviewDiagnosticHandler, webviewDiagnosticsPreload } from "./webview-diagnostics.ts";
import desktopConfig from "../electrobun.config.ts";
import { createWebviewPerformanceHandler } from "./webview-performance.ts";
import { RendererHealth } from "./renderer-health.ts";
// Electrobun 2.0.2 exposes window movement only through its native adapter.
// Keep that adapter in the main process; the sandbox gets no general RPC.
import { internalRpcHandlers } from "../.hutch/devkit/api/sdks/main/proc/native";

const development = BuildConfig.getSync().channel === "dev";
const dataDir = join(homedir(), "Library", "Application Support", development ? "Planwerk Dev" : "Planwerk");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const diagnostics = createDesktopDiagnostics(dataDir);
const appStartedAt = performance.now();
console.info("[desktop:lifecycle] Starting", { runId: diagnostics.runId, development });
const port = development ? 43128 : 43127;
const resources = join(PATHS.RESOURCES_FOLDER, "app");
let window: BrowserWindow | undefined;
let backend: Backend | undefined;
let instance: Server | null = null;
let tray: Tray | undefined;
let state: DesktopState = { kind: "starting" };
let timer: ReturnType<typeof setTimeout> | undefined;
let restarting = false;
let quitting = false;
let quitReady = false;
let lastPresentation = "";
let rendererHealth: RendererHealth | undefined;
let checkingRenderer = false;
let rendererRecoveryAttempted = false;
let rendererFailureReported = false;

function veto(event: unknown): void {
  if (!event || typeof event !== "object") throw new Error("Invalid native event");
  Reflect.set(event, "response", { allow: false });
}

function eventData(event: unknown): Record<string, unknown> {
  if (event && typeof event === "object" && "data" in event && event.data && typeof event.data === "object") {
    return event.data as Record<string, unknown>;
  }
  throw new Error("Invalid native event data");
}

function renderMenu(): void {
  const presentation = menuPresentation(state);
  const signature = JSON.stringify([presentation, Boolean(window), restarting]);
  if (signature === lastPresentation) return;
  lastPresentation = signature;
  tray?.setTitle(presentation.title);
  tray?.setMenu([
    { type: "normal", label: presentation.summary, enabled: false },
    { type: "normal", label: presentation.detail, enabled: false },
    ...(presentation.activity ? [{ type: "normal" as const, label: presentation.activity, enabled: false }] : []),
    { type: "divider" },
    { type: "normal", label: "Open Inbox", action: "inbox", enabled: Boolean(window) },
    { type: "normal", label: "Open Board", action: "board", enabled: Boolean(window) },
    { type: "divider" },
    { type: "normal", label: "Show Logs", action: "logs" },
    { type: "normal", label: "Export Diagnostics...", action: "diagnostics" },
    { type: "normal", label: "Restart Local Server...", action: "restart", enabled: !restarting },
    { type: "normal", label: "Quit Planwerk", action: "quit" },
  ]);
}

function showWindow(destination?: "inbox" | "board"): void {
  if (!window || quitting) return;
  window.unminimize();
  window.show();
  window.activate();
  window.webview.executeJavascript('window.__PLANWERK_MONITOR_VISIBLE__ = true; window.dispatchEvent(new Event("planwerk-visibility"));');
  console.info("[desktop:lifecycle] Window shown", destination ?? "current view");
  if (destination) {
    window.webview.executeJavascript(`location.hash = ${JSON.stringify(destination)};`);
  }
  void checkRenderer();
}

async function checkRenderer(): Promise<void> {
  const current = window;
  const health = rendererHealth;
  const origin = backend?.origin;
  if (checkingRenderer || quitting || restarting || state.kind !== "ready"
    || !current || !health || !origin || !current.isVisible() || current.isMinimized() || rendererFailureReported) return;
  checkingRenderer = true;
  let replacing = false;
  try {
    const responsive = await health.check();
    if (quitting || restarting || current !== window || !current.isVisible() || current.isMinimized()) return;
    if (responsive !== false) return;
    if (rendererRecoveryAttempted) throw new Error("The replacement window is not responding");
    rendererRecoveryAttempted = true;
    replacing = true;
    console.warn("[desktop:renderer] Window did not acknowledge health check; recreating");
    const replacement = createWindow(origin, current.getFrame());
    window = replacement;
    current.close();
    console.info("[desktop:renderer] Replacement window created");
  } catch (error) {
    if (quitting || restarting || (current !== window && !replacing)) return;
    rendererFailureReported = true;
    console.error("[desktop:renderer]", error);
    await Utils.showMessageBox({
      type: "error", title: "Planwerk window is not responding",
      message: String(error),
      detail: "Use Restart Local Server in the menu bar to retry. Agent sessions in VS Code are not stopped.",
    });
  } finally {
    checkingRenderer = false;
  }
}

function createWindow(
  origin: string,
  frame: { width: number; height: number; x?: number; y?: number } = { width: 1280, height: 840 },
): BrowserWindow {
  let navigationStartedAt = performance.now();
  let firstLoad = true;
  const win = new BrowserWindow({
    title: "Planwerk",
    url: origin,
    renderer: "native",
    sandbox: true,
    allowedProtocols: { views: false, appData: false },
    navigationRules: JSON.stringify(["^*", `${origin}/*`]),
    frame,
    titleBarStyle: "hiddenInset",
    trafficLightOffset: { x: 8, y: 6 },
    preload: `window.__PLANWERK_PRELOAD_MS__ = performance.now();
window.__PLANWERK_PERFORMANCE_DISABLED__ = ${process.env.PLANWERK_PERFORMANCE === "0"};\n` + titlebarPreload + webviewDiagnosticsPreload,
    spellCheck: true,
  });
  const health = new RendererHealth((script) => win.webview.executeJavascript(script));
  const cleanups: Array<() => void> = [];
  const listen = (name: string, handler: (event: unknown) => void) => {
    Electrobun.events.on(name, handler);
    cleanups.push(() => Electrobun.events.off(name, handler));
  };
  const receiveDiagnostic = createWebviewDiagnosticHandler((record) => diagnostics.webview.write(record));
  const receivePerformance = createWebviewPerformanceHandler((record) => diagnostics.webview.write(record));
  listen(`host-message-${win.webview.id}`, (event) => {
    const detail = eventData(event).detail;
    health.receive(detail);
    receiveDiagnostic(detail);
    receivePerformance(detail);
    const action = titlebarAction(detail);
    if (action === "start") internalRpcHandlers.message.startWindowMove({ id: win.id });
    else if (action === "stop") internalRpcHandlers.message.stopWindowMove({});
  });
  listen(`will-close-${win.id}`, (event) => {
    if (quitReady) return;
    veto(event);
    void quit();
  });
  Electrobun.events.once(`close-${win.id}`, () => {
    health.cancel();
    for (const cleanup of cleanups) cleanup();
  });
  listen(`dom-ready-${win.webview.id}`, () => {
    diagnostics.native.write({
      level: "INFO", scope: "performance", body: "WebKit DOM ready",
      metric: "webview.dom-ready", durationMs: performance.now() - navigationStartedAt,
      ...(firstLoad ? { startupDurationMs: performance.now() - appStartedAt } : {}),
    });
    firstLoad = false;
  });
  let lastExternal = "";
  let lastOpened = 0;
  const openLink = (event: unknown) => {
    const candidate = navigationUrl(eventData(event).detail);
    if (!candidate) return;
    if (candidate === origin || candidate.startsWith(`${origin}/`)) navigationStartedAt = performance.now();
    const url = externalUrl(candidate, origin);
    if (!url || (url === lastExternal && Date.now() - lastOpened < 1000)) return;
    lastExternal = url;
    lastOpened = Date.now();
    if (!Utils.openExternal(url)) {
      console.error("[desktop] Could not open external link");
      void Utils.showMessageBox({ type: "error", title: "Planwerk", message: "Could not open this link in its application." });
    }
  };
  listen(`will-navigate-${win.webview.id}`, openLink);
  listen(`new-window-open-${win.webview.id}`, openLink);
  rendererHealth = health;
  return win;
}

async function poll(): Promise<void> {
  if (quitting || restarting || !backend) return;
  const current = backend;
  let next: DesktopState;
  try {
    next = { kind: "ready", status: await current.status() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (state.kind !== "unavailable" || state.message !== message) {
      console.error("[desktop:inbox]", message);
    }
    next = { kind: "unavailable", message };
  }
  if (quitting || restarting || current !== backend) return;
  state = next;
  renderMenu();
  void checkRenderer();
  timer = setTimeout(() => void poll(), 3000);
}

async function startBackend(): Promise<void> {
  if (restarting || quitting) return;
  restarting = true;
  rendererHealth?.cancel();
  rendererRecoveryAttempted = false;
  rendererFailureReported = false;
  clearTimeout(timer);
  state = { kind: "starting" };
  renderMenu();
  try {
    await backend?.stop();
    if (quitting) return;
    backend = new Backend({
      resources,
      dataDir,
      port,
      runId: diagnostics.runId,
      onExit: (message) => {
        state = { kind: "unavailable", message };
        renderMenu();
      },
    });
    await backend.start();
    if (quitting) return;
    if (window) window.webview.loadURL(backend.origin);
    else window = createWindow(backend.origin);
    console.info("[desktop] Local server ready", backend.origin);
  } catch (error) {
    if (quitting) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error("[desktop:startup]", message);
    await backend?.stop();
    state = { kind: "unavailable", message };
    renderMenu();
    await Utils.showMessageBox({
      type: "error",
      title: "Planwerk could not start",
      message,
      detail: "Use Show Logs or Restart Local Server in the menu bar. No other server will be stopped.",
    });
  } finally {
    restarting = false;
    renderMenu();
  }
  void poll();
}

async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  const startedAt = performance.now();
  console.info("[desktop:lifecycle] Quitting");
  clearTimeout(timer);
  rendererHealth?.cancel();
  try {
    await backend?.stop();
    const server = instance;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      instance = null;
    }
    tray?.remove();
    tray = undefined;
    quitReady = true;
    console.info("[desktop:lifecycle] Shutdown complete; requesting native exit", {
      durationMs: performance.now() - startedAt,
    });
    if (!Utils.quit()) throw new Error("Native quit was cancelled");
  } catch (error) {
    console.error("[desktop:quit]", error);
    quitReady = false;
    quitting = false;
    await Utils.showMessageBox({
      type: "error",
      title: "Planwerk could not finish quitting",
      message: String(error),
      detail: "Shutdown did not complete. Check the logs before trying again.",
    });
    void poll();
  }
}

async function action(event: unknown): Promise<void> {
  const command = eventData(event).action;
  switch (command) {
    case "inbox": case "board": showWindow(command); break;
    case "logs":
      if (!Utils.openPath(dataDir)) {
        console.error("[desktop] Could not open log directory");
        await Utils.showMessageBox({
          type: "error", title: "Planwerk", message: "Could not open the log directory.", detail: dataDir,
        });
      }
      break;
    case "diagnostics": {
      const result = await Utils.showMessageBox({
        type: "warning", title: "Export local diagnostics?",
        message: "Save recent logs and startup timings locally. Nothing is uploaded.",
        detail: "Database and conversation files are excluded. Logs can still contain sensitive information; review the export before sharing.",
        buttons: ["Cancel", "Export"], defaultId: 0, cancelId: 0,
      });
      if (result.response !== 1) break;
      try {
        const path = await exportDiagnostics(dataDir, {
          runId: diagnostics.runId, version: desktopConfig.app.version,
          channel: development ? "dev" : "stable", state: state.kind,
        });
        console.info("[diagnostics:export] Saved", path);
        if (!Utils.openPath(path)) throw new Error(`Could not open diagnostics export: ${path}`);
      } catch (error) {
        console.error("[diagnostics:export]", error);
        await Utils.showMessageBox({ type: "error", title: "Diagnostics export failed", message: String(error) });
      }
      break;
    }
    case "restart": {
      const result = await Utils.showMessageBox({
        type: "warning",
        title: "Restart local server?",
        message: "Planwerk monitoring and in-flight coordinator work will be interrupted.",
        detail: "Agent sessions in VS Code will not be stopped. The window reconnects after restart.",
        buttons: ["Cancel", "Restart"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response === 1) await startBackend();
      break;
    }
    case "quit": await quit(); break;
  }
}

Electrobun.events.on("before-quit", (event) => {
  if (quitReady) return;
  veto(event);
  void quit();
});
Electrobun.events.on("reopen", () => showWindow());
process.on("SIGTERM", () => void quit());
process.on("SIGINT", () => void quit());
process.on("exit", (code) => {
  console.info("[desktop:lifecycle] Process exiting", { code, shutdownComplete: quitReady });
});

try {
  instance = await claimInstance(join(dataDir, "desktop.sock"), () => showWindow());
  if (!instance) {
    quitReady = true;
    Utils.quit();
  } else {
    tray = new Tray({ image: join(resources, "tray.png"), template: true, width: 22, height: 16 });
    if (!tray.id) throw new Error("macOS menu bar could not be created");
    tray.on("tray-clicked", (event) => void action(event));
    ApplicationMenu.setApplicationMenu([
      {
        label: "Planwerk", submenu: [
          { label: "About Planwerk", role: "about" },
          { type: "separator" },
          { label: "Hide Planwerk", role: "hide" },
          { label: "Hide Others", role: "hideOthers" },
          { label: "Show All", role: "showAll" },
          { type: "separator" },
          { label: "Quit Planwerk", action: "quit", accelerator: "q" },
        ],
      },
      { label: "Edit", submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      ] },
      { label: "Window", submenu: [
        { label: "Open Inbox", action: "inbox", accelerator: "1" },
        { label: "Open Board", action: "board", accelerator: "2" },
        { role: "minimize" }, { role: "zoom" },
      ] },
      { label: "Help", submenu: [
        { label: "Show Logs", action: "logs" },
        { label: "Export Diagnostics...", action: "diagnostics" },
      ] },
    ]);
    ApplicationMenu.on("application-menu-clicked", (event) => void action(event));
    renderMenu();
    await startBackend();
  }
} catch (error) {
  console.error("[desktop:fatal]", error);
  await Utils.showMessageBox({ type: "error", title: "Planwerk could not start", message: String(error) });
  await quit();
}
