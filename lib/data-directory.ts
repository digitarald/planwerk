import path from "node:path";

export function dataDirectory(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const override = env.PLANWERK_DATA_DIR;
  if (override && !path.isAbsolute(override)) {
    throw new Error("PLANWERK_DATA_DIR must be an absolute path");
  }
  return override || path.join(cwd, ".planwerk");
}
