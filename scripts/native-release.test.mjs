import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectDependencyNotices } from "./desktop-notices.mjs";
import { prepareNativeRelease, releaseVersion } from "./prepare-native-release.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pw-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("release tags must match both manifests and use a stable version", () => {
  assert.equal(releaseVersion("v0.2.0", "0.2.0", "0.2.0"), "0.2.0");
  for (const args of [
    ["v0.1.0", "0.2.0", "0.2.0"], ["v0.2.0", "0.2.0", "0.1.0"],
    ["0.2.0", "0.2.0", "0.2.0"], ["v0.2.0-beta", "0.2.0-beta", "0.2.0-beta"],
    [undefined, "0.2.0", "0.2.0"],
  ]) assert.throws(() => releaseVersion(...args), /must match/);
});

test("release preparation refuses unsupported platforms, missing bundles and empty DMGs", async (t) => {
  const root = await fixture(t);
  await assert.rejects(prepareNativeRelease(root, "v0.2.0", "x64"), /Apple Silicon/);
  await mkdir(join(root, "desktop"));
  for (const file of ["package.json", "desktop/package.json"]) {
    await writeFile(join(root, file), JSON.stringify({ version: "0.2.0" }));
  }
  await assert.rejects(prepareNativeRelease(root, "v0.2.0", "arm64"), { code: "ENOENT" });
  const app = join(root, "desktop/build/stable-macos-arm64/Planwerk.app");
  for (const file of [
    "Contents/Info.plist", "Contents/MacOS/launcher", "Contents/MacOS/bun",
    "Contents/MacOS/libElectrobunCore.dylib", "Contents/MacOS/libNativeWrapper.dylib",
    "Contents/Resources/build.json", "Contents/Resources/version.json", "Contents/Resources/main.js",
    "Contents/Resources/app/bun/index.js", "Contents/Resources/app/backend/node",
    "Contents/Resources/app/backend/server.js", "Contents/Resources/app/backend/watch-server.cjs",
    "Contents/Resources/app/backend/.next-desktop/BUILD_ID",
  ]) {
    await mkdir(dirname(join(app, file)), { recursive: true });
    await writeFile(join(app, file), "runtime", { mode: 0o755 });
  }
  const bundledVersion = join(app, "Contents/Resources/version.json");
  await writeFile(bundledVersion, JSON.stringify({ version: "0.1.0", channel: "stable" }));
  await assert.rejects(prepareNativeRelease(root, "v0.2.0", "arm64"), /Bundled app must be/);
  await writeFile(bundledVersion, JSON.stringify({ version: "0.2.0", channel: "dev" }));
  await assert.rejects(prepareNativeRelease(root, "v0.2.0", "arm64"), /Bundled app must be/);
  await writeFile(bundledVersion, JSON.stringify({ version: "0.2.0", channel: "stable" }));
  await mkdir(join(root, "desktop/artifacts"));
  const dmg = join(root, "desktop/artifacts/macos-arm64-Planwerk.dmg");
  await writeFile(dmg, "");
  await assert.rejects(prepareNativeRelease(root, "v0.2.0", "arm64"), /empty/);
  await writeFile(dmg, "disk image");
  const output = await prepareNativeRelease(root, "v0.2.0", "arm64");
  const name = "Planwerk-0.2.0-macos-arm64.dmg";
  assert.equal(await readFile(join(output, name), "utf8"), "disk image");
  assert.equal(await readFile(join(output, "SHA256SUMS"), "utf8"),
    `${createHash("sha256").update("disk image").digest("hex")}  ${name}\n`);
  await assert.rejects(prepareNativeRelease(root, "v0.2.0", "arm64"), { code: "EEXIST" });
});

test("dependency notices preserve upstream files and index runtime packages only", async (t) => {
  const root = await fixture(t);
  const path = "node_modules/example";
  await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, path, "LICENSE.txt"), "upstream license");
  await writeFile(join(root, path, "NOTICE"), "upstream notice");
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ packages: {
    "": { version: "0.2.0" },
    [path]: { version: "1.0.0", license: "MIT" },
    "node_modules/dev-only": { dev: true },
    "node_modules/other-platform": { optional: true },
  } }));
  const output = join(root, "notices");
  await collectDependencyNotices(root, output);
  assert.equal(await readFile(join(output, path, "LICENSE.txt"), "utf8"), "upstream license");
  const index = JSON.parse(await readFile(join(output, "index.json"), "utf8"));
  assert.equal(index.length, 1);
  assert.equal(index[0].license, "MIT");
  assert.deepEqual(index[0].noticeFiles.sort(), ["LICENSE.txt", "NOTICE"]);
  await rm(join(root, path), { recursive: true });
  await assert.rejects(collectDependencyNotices(root, output), { code: "ENOENT" });
});
