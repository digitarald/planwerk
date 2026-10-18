import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? `exit ${result.status}`})`);
  }
}

export async function validateDesktopBundle(app) {
  const resources = join(app, "Contents/Resources");
  const entries = await readdir(resources);
  if (entries.some((entry) => entry === "metadata.json" || entry.endsWith(".tar.zst"))) {
    throw new Error(`Expected a runnable app, found an installer wrapper: ${app}`);
  }
  const executables = [
    "Contents/MacOS/launcher",
    "Contents/MacOS/bun",
    "Contents/Resources/app/backend/node",
  ];
  const files = [
    ...executables,
    "Contents/Info.plist",
    "Contents/MacOS/libElectrobunCore.dylib",
    "Contents/MacOS/libNativeWrapper.dylib",
    "Contents/Resources/build.json",
    "Contents/Resources/version.json",
    "Contents/Resources/main.js",
    "Contents/Resources/app/bun/index.js",
    "Contents/Resources/app/backend/server.js",
    "Contents/Resources/app/backend/watch-server.cjs",
    "Contents/Resources/app/backend/.next-desktop/BUILD_ID",
  ];
  for (const file of files) {
    const path = join(app, file);
    if (!(await stat(path)).isFile()) throw new Error(`Missing application file: ${path}`);
    await access(path, constants.R_OK | (executables.includes(file) ? constants.X_OK : 0));
  }
}

export async function packageDesktop(desktop, arch = process.arch, execute = run) {
  if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported macOS architecture: ${arch}`);
  const build = join(desktop, "build", `stable-macos-${arch}`);
  const artifacts = join(desktop, "artifacts");
  const archive = join(artifacts, `stable-macos-${arch}-Planwerk.app.tar.zst`);
  await access(archive, constants.R_OK);
  await mkdir(build, { recursive: true });
  const staging = await mkdtemp(join(build, ".native-package-"));
  try {
    const image = join(staging, "image");
    await mkdir(image);
    await execute("tar", ["-xf", archive, "-C", image], desktop);
    const app = join(image, "Planwerk.app");
    await validateDesktopBundle(app);
    await symlink("/Applications", join(image, "Applications"));
    const dmg = join(staging, "Planwerk.dmg");
    await execute("hdiutil", [
      "create", "-volname", "Planwerk", "-srcfolder", image,
      "-format", "UDZO", dmg,
    ], desktop);
    await access(dmg, constants.R_OK);
    // Publish only a validated runtime bundle, never the toolchain's installer.
    const destination = join(build, "Planwerk.app");
    await rm(destination, { recursive: true, force: true });
    await rename(app, destination);
    const artifact = join(artifacts, `macos-${arch}-Planwerk.dmg`);
    await rename(dmg, artifact);
    return { app: destination, dmg: artifact };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
