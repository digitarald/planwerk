import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopPreferences, parsePreferences, restoreFrame } from "./preferences.ts";

test("preferences atomically persist zoom and normal geometry across relaunch", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "planwerk-preferences-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "preferences.json");
  const preferences = new DesktopPreferences(path, () => assert.fail("Unexpected preference error"));
  assert.deepEqual(preferences.value, { zoom: 100 });
  const saved = { zoom: 150, normalFrame: { x: -1200, y: -100, width: 900, height: 600 } };
  preferences.update(saved);
  preferences.flush();
  assert.deepEqual(new DesktopPreferences(path, () => assert.fail()).value, saved);
  preferences.update({ ...saved, zoom: 200 });
  preferences.flush();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).zoom, 200);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["preferences.json"]);
});

test("corrupt, unreadable and unwritable preferences report errors and retain pending saves", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "planwerk-preferences-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const errors: string[] = [];
  const report = (operation: string) => { errors.push(operation); };
  const path = join(dir, "preferences.json");
  writeFileSync(path, "{broken");
  assert.deepEqual(new DesktopPreferences(path, report).value, { zoom: 100 });
  new DesktopPreferences(dir, report);
  const blocked = join(dir, "missing", "preferences.json");
  const preferences = new DesktopPreferences(blocked, report);
  preferences.update({ zoom: 50 });
  preferences.flush();
  assert.deepEqual(errors, ["read", "read", "save"]);
  mkdirSync(join(dir, "missing"));
  preferences.flush();
  assert.equal(JSON.parse(readFileSync(blocked, "utf8")).zoom, 50);
});

test("preference changes debounce into the latest saved value", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "planwerk-preferences-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "preferences.json");
  const preferences = new DesktopPreferences(path, () => assert.fail("Unexpected preference error"));
  preferences.update({ zoom: 110 });
  preferences.update({ zoom: 120 });
  assert.deepEqual(readdirSync(dir), []);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).zoom, 120);
});

test("preferences reject invalid zoom, nonfinite geometry and invalid dimensions", () => {
  for (const zoom of [0, 49, 55, 201, NaN, Infinity, "100", null]) {
    assert.throws(() => parsePreferences({ zoom }));
  }
  for (const frame of [{ x: 0, y: 0, width: 0, height: 1 }, { x: Infinity, y: 0, width: 1, height: 1 }, null]) {
    assert.throws(() => parsePreferences({ zoom: 100, normalFrame: frame }));
  }
  assert.equal(parsePreferences({ zoom: 50 }).zoom, 50);
  assert.equal(parsePreferences({ zoom: 200 }).zoom, 200);
});

test("restoration retains negative display coordinates and clamps removed/oversized frames", () => {
  const primary = { isPrimary: true, workArea: { x: 0, y: 25, width: 1440, height: 850 } };
  const secondary = { isPrimary: false, workArea: { x: -1920, y: -400, width: 1920, height: 1080 } };
  const saved = { x: -1500, y: -200, width: 900, height: 600 };
  assert.deepEqual(restoreFrame(saved, [primary, secondary]), saved);
  assert.deepEqual(restoreFrame(saved, [primary]), { x: 0, y: 25, width: 900, height: 600 });
  assert.deepEqual(restoreFrame({ x: -100, y: 0, width: 3000, height: 2000 }, [primary]), primary.workArea);
  assert.deepEqual(restoreFrame(undefined, [primary]), { x: 80, y: 30, width: 1280, height: 840 });
  assert.throws(() => restoreFrame(saved, []), /No usable display/);
});
