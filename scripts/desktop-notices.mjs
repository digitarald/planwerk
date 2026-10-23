import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function collectDependencyNotices(root, destination) {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  await mkdir(destination, { recursive: true });
  const packages = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.dev) continue;
    const source = join(root, path);
    let files;
    try {
      files = await readdir(source, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && entry.optional) continue;
      throw error;
    }
    const notices = files.filter((file) => file.isFile()
      && /^(licen[sc]e|copying|notice|copyright)([.\-_]|$)/i.test(file.name));
    const output = join(destination, path);
    await mkdir(output, { recursive: true });
    for (const file of notices) {
      await cp(join(source, file.name), join(output, file.name));
    }
    if (notices.length === 0) {
      const readme = files.find((file) => file.isFile() && /^readme(\.|$)/i.test(file.name));
      if (readme) await cp(join(source, readme.name), join(output, readme.name));
      console.warn(`No standalone license file supplied by ${path}; see license metadata and upstream README.`);
    }
    packages.push({ path, version: entry.version, license: entry.license ?? null,
      noticeFiles: notices.map((file) => file.name) });
  }
  await writeFile(join(destination, "index.json"), `${JSON.stringify(packages, null, 2)}\n`);
}
