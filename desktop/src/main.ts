import Electrobun, { ApplicationMenu, BrowserWindow, BuildConfig, PATHS, Tray, Utils } from "electrobun/main";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { Backend } from "./backend.ts";
import { claimInstance } from "./instance.ts";
import { externalUrl, menuPresentation, navigationUrl, type DesktopState } from "./model.ts";
import { titlebarAction, titlebarPreload } from "./titlebar.ts";
// Electrobun 2.0.2 exposes window movement only through its native adapter.
// Keep that adapter in the main process; the sandbox gets no general RPC.
import { internalRpcHandlers } from "../.hutch/devkit/api/sdks/main/proc/native";

const development = BuildConfig.getSync().channel === "dev";
const dataDir = join(homedir(), "Library", "Application Support", development ? "Planwerk Dev" : "Planwerk");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
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
    { type: "normal", label: "Restart Local Server...", action: "restart", enabled: !restarting },
    { type: "normal", label: "Quit Planwerk", action: "quit" },
  ]);
}

function showWindow(destination?: "inbox" | "board"): void {
  if (!window) return;
  window.unminimize();
  window.show();
  window.activate();
  if (destination) {
    window.webview.executeJavascript(`location.hash = ${JSON.stringify(destination)};`);
  }
}

function createWindow(origin: string): BrowserWindow {
  const win = new BrowserWindow({
    title: "Planwerk",
    url: origin,
    renderer: "native",
    sandbox: true,
    allowedProtocols: { views: false, appData: false },
    navigationRules: JSON.stringify(["^*", `${origin}/*`]),
    frame: { width: 1280, height: 840 },
    titleBarStyle: "hiddenInset",
    trafficLightOffset: { x: 8, y: 6 },
    preload: titlebarPreload,
    spellCheck: true,
  });
  Electrobun.events.on(`host-message-${win.webview.id}`, (event: unknown) => {
    const action = titlebarAction(eventData(event).detail);
    if (action === "start") internalRpcHandlers.message.startWindowMove({ id: win.id });
    else if (action === "stop") internalRpcHandlers.message.stopWindowMove({});
  });
  win.on("will-close", (event) => {
    if (quitting) return;
    veto(event);
    win.hide();
  });
  win.webview.on("dom-ready", () => console.info("[desktop] WebKit window ready"));
  let lastExternal = "";
  let lastOpened = 0;
  const openLink = (event: unknown) => {
    const candidate = navigationUrl(eventData(event).detail);
    if (!candidate) return;
    const url = externalUrl(candidate, origin);
    if (!url || (url === lastExternal && Date.now() - lastOpened < 1000)) return;
    lastExternal = url;
    lastOpened = Date.now();
    if (!Utils.openExternal(url)) {
      console.error("[desktop] Could not open external link");
      void Utils.showMessageBox({ type: "error", title: "Planwerk", message: "Could not open this link in its application." });
    }
  };
  win.webview.on("will-navigate", openLink);
  Electrobun.events.on(`new-window-open-${win.webview.id}`, openLink);
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
  timer = setTimeout(() => void poll(), 3000);
}

async function startBackend(): Promise<void> {
  if (restarting || quitting) return;
  restarting = true;
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
  clearTimeout(timer);
  try {
    await backend?.stop();
    instance?.close();
    tray?.remove();
    quitReady = true;
    Utils.quit();
  } catch (error) {
    console.error("[desktop:quit]", error);
    quitting = false;
    await Utils.showMessageBox({
      type: "error",
      title: "Planwerk could not finish quitting",
      message: String(error),
      detail: "The local server could not be stopped. Check the logs before trying again.",
    });
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
