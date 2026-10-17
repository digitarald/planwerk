import assert from "node:assert/strict";
import test from "node:test";
import { externalUrl, menuPresentation, navigationUrl, parseStatus } from "./model.ts";

test("menu preserves unread versus unresolved and never calls disconnected data zero", () => {
  const ready = (unread: number, open = unread) => menuPresentation({
    kind: "ready", status: { unread, open, connected: true, running: 0 },
  });
  assert.equal(ready(0, 4).title, "");
  assert.equal(ready(0, 4).detail, "4 unresolved across all workspaces");
  assert.equal(ready(1).summary, "1 unread inbox item");
  assert.equal(ready(99).title, "99");
  assert.equal(ready(100).title, "99+");
  assert.equal(ready(100).summary, "100 unread inbox items");
  assert.equal(menuPresentation({ kind: "ready", status: { unread: 0, open: 0, connected: false, running: 0 } }).icon, "offline");
  assert.equal(menuPresentation({ kind: "unavailable", message: "Offline" }).icon, "offline");
  assert.equal(menuPresentation({ kind: "starting" }).icon, "starting");
  assert.equal(ready(0).icon, "idle");
  assert.equal(ready(1).icon, "unread");
});

test("invalid status is an error, not an empty inbox", () => {
  for (const value of [null, {}, { unread: -1, open: 0, connected: true },
    { unread: "3", open: 4, connected: true }, { unread: 5, open: 4, connected: true },
    { unread: 0.1, open: 4, connected: true }, { unread: 0, open: 4 }]) {
    assert.throws(() => parseStatus(value));
  }
  assert.deepEqual(parseStatus({ unread: 1, open: 2, connected: true, running: 3 }), { unread: 1, open: 2, connected: true, running: 3 });
});

test("activity stays distinct from unread count, with no stale progress on disconnect", () => {
  for (const unread of [0, 4]) {
    const status = { unread, open: unread, connected: true, running: 2 };
    const presentation = menuPresentation({ kind: "ready", status });
    assert.equal(presentation.icon, "working");
    assert.equal(presentation.title, unread ? "◔ 4" : "◔");
    assert.equal(presentation.activity, "2 sessions running");
    const disconnected = menuPresentation({ kind: "ready", status: { ...status, connected: false } });
    assert.equal(disconnected.icon, "offline");
    assert.equal(disconnected.activity, null);
    assert.equal(disconnected.title, "!");
  }
  for (const running of [-1, 0.5, "2", null, undefined]) {
    assert.throws(() => parseStatus({ unread: 0, open: 0, connected: true, running }));
  }
});

test("external link handling never opens arbitrary local files or executable schemes", () => {
  const origin = "http://127.0.0.1:43127";
  for (const value of [`${origin}/`, "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "invalid", "https://user:password@example.com"]) {
    assert.equal(externalUrl(value, origin), null);
  }
  assert.equal(externalUrl("https://github.com", origin), "https://github.com/");
  assert.equal(externalUrl("vscode://file/Users/example/project", origin), "vscode://file/Users/example/project");
});

test("WebKit navigation and new-window events both yield the external destination", () => {
  const url = "https://github.com/digitarald/planwerk";
  assert.equal(navigationUrl(JSON.stringify({ url, allowed: false })), url);
  assert.equal(navigationUrl({ url, isCmdClick: true }), url);
  assert.equal(navigationUrl(url), url);
  assert.equal(navigationUrl({ allowed: false }), null);
  assert.throws(() => navigationUrl("{broken payload"));
});
