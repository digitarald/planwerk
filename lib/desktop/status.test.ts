import assert from "node:assert/strict";
import test from "node:test";
import { desktopHosts, registerDesktopHosts } from "./status.ts";

test("desktop reads the live registry rather than retaining stale connected hosts", () => {
  let connected = true;
  let running = 2;
  registerDesktopHosts(() => [{ hostUrl: "vscode://local", connected, running }]);
  assert.equal(desktopHosts()[0].connected, true);
  assert.equal(desktopHosts()[0].running, 2);
  running = 0;
  assert.equal(desktopHosts()[0].running, 0);
  connected = false;
  assert.equal(desktopHosts()[0].connected, false);
  registerDesktopHosts(() => []);
  assert.deepEqual(desktopHosts(), []);
});
