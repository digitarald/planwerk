import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDesktopBundle } from "./package-desktop.mjs";

export function releaseVersion(tag, version, desktopVersion) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}` || desktopVersion !== version) {
    throw new Error(`Release tag ${tag} must match root and desktop versions (${version}, ${desktopVersion})`);
  }
  return version;
}

export async function prepareNativeRelease(root, tag, arch = process.arch) {
  if (arch !== "arm64") throw new Error("Published native previews support Apple Silicon only");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const desktopManifest = JSON.parse(await readFile(join(root, "desktop/package.json"), "utf8"));
  const version = releaseVersion(tag, manifest.version, desktopManifest.version);
  const app = join(root, "desktop/build/stable-macos-arm64/Planwerk.app");
  await validateDesktopBundle(app);
  const bundled = JSON.parse(await readFile(join(app, "Contents/Resources/version.json"), "utf8"));
  if (bundled.version !== version || bundled.channel !== "stable") {
    throw new Error(`Bundled app must be a stable ${version} build, not ${bundled.version} (${bundled.channel})`);
  }
  const dmg = join(root, "desktop/artifacts/macos-arm64-Planwerk.dmg");
  const image = await stat(dmg);
  if (!image.isFile() || image.size === 0) {
    throw new Error("Native release DMG is missing or empty");
  }
  const output = join(root, "desktop/artifacts", tag);
  await mkdir(output);
  const name = `Planwerk-${version}-macos-arm64.dmg`;
  const artifact = join(output, name);
  await cp(dmg, artifact);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  await writeFile(join(output, "SHA256SUMS"), `${hash.digest("hex")}  ${name}\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  console.info(await prepareNativeRelease(root, process.argv[2]));
}
