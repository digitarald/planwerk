import { cp, mkdir, readFile, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import sharp from "sharp";
import { packageDesktop, run as execute } from "./package-desktop.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = join(root, "desktop");
const payload = join(desktop, "payload");
const generated = join(desktop, "generated");
const dev = process.argv.includes("--dev");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (process.platform !== "darwin") throw new Error("Native packaging currently targets macOS");
if (process.versions.node !== manifest.engines.node) {
  throw new Error(`Build with Node ${manifest.engines.node}; the packaged binary must match native modules`);
}

function run(command, args, cwd = root, env = process.env) {
  execute(command, args, cwd, env);
}

run("npm", ["run", "typecheck"], desktop);
run(process.execPath, ["node_modules/next/dist/bin/next", "build"], root, {
  ...process.env,
  PLANWERK_DESKTOP_BUILD: "1",
});
// Only this script's generated staging directories are replaced.
await rm(payload, { recursive: true, force: true });
await mkdir(generated, { recursive: true });
await cp(join(root, ".next-desktop/standalone"), payload, {
  recursive: true,
  dereference: true,
  filter: (source) => !basename(source).startsWith(".env")
    && basename(source) !== ".planwerk"
    && source !== join(root, ".next-desktop/standalone/.github"),
});
await cp(join(root, ".next-desktop/static"), join(payload, ".next-desktop/static"), { recursive: true });
await cp(join(root, "public"), join(payload, "public"), { recursive: true });
await cp(process.execPath, join(payload, "node"));
await chmod(join(payload, "node"), 0o755);
await mkdir(join(payload, "bin"), { recursive: true });
await symlink("../node", join(payload, "bin/node"));
await cp(join(desktop, "watch-server.cjs"), join(payload, "watch-server.cjs"));

const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
if (!license.ok) throw new Error(`Node license download failed: ${license.status}`);
await writeFile(join(payload, "NODE-LICENSE"), await license.text());

const iconset = join(generated, "Planwerk.iconset");
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await sharp(join(root, "public/logo-light-256.png"))
      .resize(size * scale, size * scale)
      .png()
      .toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`));
  }
}
// Keep the template image fixed: Electrobun 2.0.2 setImage loses its size/template.
await sharp(Buffer.from('<svg width="44" height="32" viewBox="0 0 44 32" xmlns="http://www.w3.org/2000/svg"><path d="M22 16C16 4 3 5 3 16s13 12 19 0S41 5 41 16 28 28 22 16Z" fill="none" stroke="black" stroke-width="3" stroke-linecap="round"/></svg>'))
  .png().toFile(join(generated, "tray.png"));

run("npm", ["run", dev ? "build:dev" : "build"], desktop);
if (!dev) await packageDesktop(desktop);
console.info(`Native ${dev ? "development" : "release"} app built in desktop/build (unsigned).`);
