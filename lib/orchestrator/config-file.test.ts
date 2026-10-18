import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { isWorkspaceEnabled, readConfigFile } from "./config-file.ts";

test("nearest folder configuration supports both YAML extensions and file URLs", (t) => {
  const root = mkdtempSync(join(tmpdir(), "planwerk-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".github"));
  mkdirSync(join(root, "notes", ".github"), { recursive: true });
  mkdirSync(join(root, "notes", "daily"), { recursive: true });
  const rootFile = join(root, ".github", "planwerk.yml");
  writeFileSync(rootFile, "risk_assessment:\n  guidance: Consider reversibility and user exposure.\n");
  const nested = join(root, "notes", "daily");
  assert.equal(readConfigFile(nested)?.path, rootFile);
  assert.equal(readConfigFile(nested)?.riskGuidance, "Consider reversibility and user exposure.");
  writeFileSync(join(root, "notes", ".github", "planwerk.yaml"), "enabled: false\n");
  assert.equal(isWorkspaceEnabled({ workingDirectory: pathToFileURL(nested).href }), false);
  assert.equal(isWorkspaceEnabled({ project: { path: root } }), true);
  assert.equal(isWorkspaceEnabled({ workingDirectories: [root, nested] }), false);
  assert.equal(isWorkspaceEnabled({}), true);
});

test("discovery stops at a repository boundary and does not consult Planwerk's cwd", (t) => {
  const root = mkdtempSync(join(tmpdir(), "planwerk-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github", "planwerk.yml"), "enabled: false\n");
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(root, "repo", "src"));
  assert.equal(readConfigFile(join(root, "repo", "src")), undefined);
  assert.equal(readConfigFile("vscode-remote://host/repo"), undefined);
});

test("edits and removal invalidate the cache; yml has precedence over yaml", (t) => {
  const root = mkdtempSync(join(tmpdir(), "planwerk-reload-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github"));
  const file = join(root, ".github", "planwerk.yml");
  writeFileSync(join(root, ".github", "planwerk.yaml"), "enabled: false\n");
  writeFileSync(file, "enabled: true\n");
  assert.equal(readConfigFile(root)?.enabled, true);
  writeFileSync(file, "enabled: false\n");
  assert.equal(readConfigFile(root)?.enabled, false);
  rmSync(file);
  assert.equal(readConfigFile(root)?.path, join(root, ".github", "planwerk.yaml"));
});

test("invalid configuration is explicit rather than silently enabling automation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "planwerk-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github"));
  const file = join(root, ".github", "planwerk.yml");
  for (const value of ["enabled: no", "risk_assessment: low", "risk_assessment:\n  guidance: false", "- list", "["]) {
    writeFileSync(file, value);
    assert.throws(() => readConfigFile(root));
  }
});
