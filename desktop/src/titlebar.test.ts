import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { titlebarAction, titlebarPreload, titlebarZoom } from "./titlebar.ts";

test("titlebar channel accepts only moving the owning window", () => {
  assert.equal(titlebarAction({ type: "titlebar", action: "start", id: 999 }), "start");
  assert.equal(titlebarAction({ type: "titlebar", action: "stop" }), "stop");
  for (const value of [null, "start", {}, { type: "titlebar", action: "execute" }, { type: "rpc", action: "start" }]) {
    assert.equal(titlebarAction(value), null);
  }
});

test("native traffic-light clearance stays fixed at every zoom, including document start", () => {
  for (const percent of [50, 100, 200]) {
    const properties = new Map<string, string>();
    let ready!: () => void;
    const document: { documentElement: { style: { setProperty: (key: string, value: string) => void } } | null; addEventListener: (_name: string, handler: () => void) => void } = {
      documentElement: null,
      addEventListener: (_name, handler) => { ready = handler; },
    };
    runInNewContext(titlebarZoom(percent), { document });
    document.documentElement = { style: { setProperty: (key, value) => properties.set(key, value) } };
    ready();
    assert.equal(parseFloat(properties.get("--desktop-traffic-inset")!) * percent / 100, 88);
    assert.equal(parseFloat(properties.get("--desktop-header-min-height")!) * percent / 100, 44);
    runInNewContext(titlebarZoom(percent), { document });
  }
});

test("header drag excludes controls and synthetic events, and stops on blur", () => {
  const documentHandlers = new Map<string, (event: object) => void>();
  const windowHandlers = new Map<string, () => void>();
  const actions: string[] = [];
  class Element {
    header: boolean;
    interactive: boolean;
    constructor(header: boolean, interactive: boolean) {
      this.header = header;
      this.interactive = interactive;
    }
    closest(selector: string) {
      return selector === "[data-desktop-titlebar]" ? this.header : this.interactive;
    }
  }
  const window = {
    __electrobunSendToHost: (message: { action: string }) => actions.push(message.action),
    addEventListener: (name: string, handler: () => void) => windowHandlers.set(name, handler),
  };
  runInNewContext(titlebarPreload, {
    window, Element,
    document: { addEventListener: (name: string, handler: (event: object) => void) => documentHandlers.set(name, handler) },
  });
  const down = (target: Element, isTrusted = true, button = 0) =>
    documentHandlers.get("mousedown")!({ target, isTrusted, button });
  down(new Element(true, true));
  down(new Element(false, false));
  down(new Element(true, false), false);
  down(new Element(true, false), true, 2);
  assert.deepEqual(actions, []);
  down(new Element(true, false));
  windowHandlers.get("blur")!();
  documentHandlers.get("mouseup")!({});
  assert.deepEqual(actions, ["start", "stop"]);
});
