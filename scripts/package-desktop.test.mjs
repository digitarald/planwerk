import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { packageDesktop, run, validateDesktopBundle } from "./package-desktop.mjs";

async function fixture(t) {
  const desktop = await mkdtemp(join(tmpdir(), "pw-package-"));
  t.after(() => rm(desktop, { recursive: true, force: true }));
  return desktop;
}

async function bundle(app) {
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
}

for (const arch of ["arm64", "x64"]) {
  test(`packages the real ${arch} app and conventional DMG`, async (t) => {
    const desktop = await fixture(t);
    const artifacts = join(desktop, "artifacts");
    await mkdir(artifacts);
    const archive = join(artifacts, `stable-macos-${arch}-Planwerk.app.tar.zst`);
    await writeFile(archive, "archive");
    await writeFile(join(artifacts, "update.json"), "preserve");
    const oldApp = join(desktop, "build", `stable-macos-${arch}`, "Planwerk.app");
    await mkdir(oldApp, { recursive: true });
    await writeFile(join(oldApp, "installer"), "old");
    const calls = [];
    const result = await packageDesktop(desktop, arch, async (command, args, cwd) => {
      calls.push(command);
      assert.equal(cwd, desktop);
      if (command === "tar") {
        assert.deepEqual(args.slice(0, 3), ["-xf", archive, "-C"]);
        await bundle(join(args[3], "Planwerk.app"));
      } else {
        assert.equal(command, "hdiutil");
        assert.equal(args[0], "create");
        assert.equal(args[args.indexOf("-format") + 1], "UDZO");
        const image = args[args.indexOf("-srcfolder") + 1];
        assert.deepEqual((await readdir(image)).sort(), ["Applications", "Planwerk.app"]);
        assert.equal(await readlink(join(image, "Applications")), "/Applications");
        await validateDesktopBundle(join(image, "Planwerk.app"));
        await writeFile(args.at(-1), "dmg");
      }
    });
    assert.deepEqual(calls, ["tar", "hdiutil"]);
    assert.equal(result.app, oldApp);
    assert.equal(result.dmg, join(artifacts, `macos-${arch}-Planwerk.dmg`));
    await validateDesktopBundle(result.app);
    assert.equal(await readFile(result.dmg, "utf8"), "dmg");
    assert.equal(await readFile(join(artifacts, "update.json"), "utf8"), "preserve");
    assert.deepEqual(await readdir(dirname(oldApp)), ["Planwerk.app"]);
    await assert.rejects(readFile(join(oldApp, "installer")), { code: "ENOENT" });
  });
}

test("rejects installer wrappers, incomplete bundles and non-executable runtimes", async (t) => {
  const app = join(await fixture(t), "Planwerk.app");
  await bundle(app);
  for (const name of ["metadata.json", "payload.tar.zst"]) {
    const file = join(app, "Contents/Resources", name);
    await writeFile(file, "installer");
    await assert.rejects(validateDesktopBundle(app), /installer wrapper/);
    await rm(file);
  }
  const launcher = join(app, "Contents/MacOS/launcher");
  await chmod(launcher, 0o644);
  await assert.rejects(validateDesktopBundle(app), { code: "EACCES" });
  await chmod(launcher, 0o755);
  await rm(join(app, "Contents/Resources/app/backend/server.js"));
  await assert.rejects(validateDesktopBundle(app), { code: "ENOENT" });
});

for (const failure of ["tar", "hdiutil", "validation"]) {
  test(`cleans staging and preserves previous output on ${failure} failure`, async (t) => {
    const desktop = await fixture(t);
    const artifacts = join(desktop, "artifacts");
    await mkdir(artifacts);
    await writeFile(join(artifacts, "stable-macos-arm64-Planwerk.app.tar.zst"), "archive");
    const dmg = join(artifacts, "macos-arm64-Planwerk.dmg");
    await writeFile(dmg, "previous");
    const app = join(desktop, "build/stable-macos-arm64/Planwerk.app");
    await bundle(app);
    await assert.rejects(packageDesktop(desktop, "arm64", async (command, args) => {
      if (command === failure) throw new Error(`${failure} failed`);
      if (command === "tar") {
        const extracted = join(args[3], "Planwerk.app");
        await bundle(extracted);
        if (failure === "validation") await writeFile(join(extracted, "Contents/Resources/metadata.json"), "{}");
      } else {
        assert.fail("DMG creation must not follow validation failure");
      }
    }), failure === "validation" ? /installer wrapper/ : new RegExp(`${failure} failed`));
    await validateDesktopBundle(app);
    assert.equal(await readFile(dmg, "utf8"), "previous");
    assert.deepEqual(await readdir(dirname(app)), ["Planwerk.app"]);
  });
}

test("rejects unsupported architectures and missing archives", async (t) => {
  const desktop = await fixture(t);
  await assert.rejects(packageDesktop(desktop, "ia32"), /Unsupported macOS architecture/);
  await assert.rejects(packageDesktop(desktop, "arm64"), { code: "ENOENT" });
  assert.deepEqual(await readdir(desktop), []);
});

test("command errors and unsuccessful exits fail explicitly", () => {
  assert.throws(() => run("/nonexistent/planwerk-packaging-command", []), /ENOENT/);
  assert.throws(() => run(process.execPath, ["-e", "process.exit(7)"]), /exit 7/);
});
