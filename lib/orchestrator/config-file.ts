import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { resolveGateWorkingDirectory } from "./gate-command.ts";

interface ConfigFile {
  path: string;
  raw: Record<string, unknown>;
  enabled: boolean;
  riskGuidance?: string;
}

const cache = new Map<string, { mtime: number; size: number; config: ConfigFile }>();

export function readConfigFile(projectPath?: string): ConfigFile | undefined {
  if (projectPath && /^[a-z][a-z\d+.-]*:/i.test(projectPath)
    && !projectPath.startsWith("file:") && !/^[a-z]:[\\/]/i.test(projectPath)) {
    return undefined;
  }
  let directory = resolve(resolveGateWorkingDirectory(
    projectPath ?? process.env.PLANWERK_DATA_DIR ?? process.cwd(),
  ));
  while (true) {
    for (const name of ["planwerk.yml", "planwerk.yaml"]) {
      const path = resolve(directory, ".github", name);
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      const previous = cache.get(path);
      if (previous?.mtime === stat.mtimeMs && previous.size === stat.size) {
        return previous.config;
      }
      const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid Planwerk configuration in ${path}: expected a mapping`);
      }
      const raw = parsed as Record<string, unknown>;
      if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
        throw new Error(`Invalid enabled in ${path}: expected a boolean`);
      }
      let riskGuidance: string | undefined;
      if (raw.risk_assessment !== undefined) {
        const policy = raw.risk_assessment;
        if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
          throw new Error(`Invalid risk_assessment in ${path}: expected a mapping`);
        }
        const guidance = (policy as Record<string, unknown>).guidance;
        if (guidance !== undefined) {
          if (typeof guidance !== "string" || !guidance.trim()) {
            throw new Error(`Invalid risk_assessment.guidance in ${path}: expected non-empty text`);
          }
          riskGuidance = guidance.trim();
        }
      }
      const config: ConfigFile = { path, raw, enabled: raw.enabled !== false, riskGuidance };
      cache.set(path, { mtime: stat.mtimeMs, size: stat.size, config });
      return config;
    }
    const parent = dirname(directory);
    if (!projectPath || parent === directory || existsSync(resolve(directory, ".git"))) {
      return undefined;
    }
    directory = parent;
  }
}

export interface ConfiguredWorkspace {
  workingDirectory?: string;
  workingDirectories?: string[];
  project?: { path: string };
}

export function isWorkspaceEnabled(workspace: ConfiguredWorkspace): boolean {
  const paths = workspace.workingDirectories?.length
    ? workspace.workingDirectories
    : [workspace.workingDirectory ?? workspace.project?.path].filter(
      (path): path is string => Boolean(path),
    );
  return paths.every((path) => readConfigFile(path)?.enabled !== false);
}
