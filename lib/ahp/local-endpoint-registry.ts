import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir, platform as currentPlatform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const REGISTRY_SCHEMA_VERSION = 2;
const PRODUCT_NAMES = ["Code - Insiders", "Code"] as const;
const ENTRY_FILE = /^[0-9a-f]{64}\.json$/;

export interface LocalEditorEndpoint {
  socketPath: string;
  connectionToken: string;
  protocolVersion: string;
  pid: number;
  instanceId: string;
  modifiedAt: number;
}

interface RegistryEntry {
  schemaVersion: 2;
  type: "editor" | "standalone";
  pid: number;
  instanceId: string;
  protocolVersion: string;
  connectionToken: string;
  endpoint:
    | { type: "socket"; path: string }
    | { type: "tcp"; host: string; port: number };
}

interface RegistryPathOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  cwd?: string;
}

function resolveOverride(value: string, cwd: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export function vscodeUserDataPaths(options: RegistryPathOptions = {}): string[] {
  const platform = options.platform ?? currentPlatform();
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();

  if (env.AHP_VSCODE_USER_DATA_DIR) {
    return [resolveOverride(env.AHP_VSCODE_USER_DATA_DIR, cwd)];
  }

  if (env.VSCODE_PORTABLE) {
    return [join(resolveOverride(env.VSCODE_PORTABLE, cwd), "user-data")];
  }

  const productRoot = env.VSCODE_APPDATA
    ? resolveOverride(env.VSCODE_APPDATA, cwd)
    : platform === "darwin"
      ? join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || join(env.USERPROFILE || home, "AppData", "Roaming")
        : env.XDG_CONFIG_HOME || join(home, ".config");

  return PRODUCT_NAMES.map((productName) =>
    join(/* turbopackIgnore: true */ productRoot, productName));
}

function parseRegistryEntry(raw: unknown): RegistryEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== REGISTRY_SCHEMA_VERSION
    || (value.type !== "editor" && value.type !== "standalone")
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) <= 0
    || typeof value.instanceId !== "string"
    || !value.instanceId
    || typeof value.protocolVersion !== "string"
    || !value.protocolVersion
    || typeof value.connectionToken !== "string"
    || !value.connectionToken
    || !value.endpoint
    || typeof value.endpoint !== "object"
  ) {
    return undefined;
  }

  const endpoint = value.endpoint as Record<string, unknown>;
  if (endpoint.type === "socket" && typeof endpoint.path === "string" && endpoint.path) {
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      type: value.type,
      pid: value.pid as number,
      instanceId: value.instanceId,
      protocolVersion: value.protocolVersion,
      connectionToken: value.connectionToken,
      endpoint: { type: "socket", path: endpoint.path },
    };
  }
  if (
    endpoint.type === "tcp"
    && typeof endpoint.host === "string"
    && Number.isSafeInteger(endpoint.port)
    && (endpoint.port as number) > 0
    && (endpoint.port as number) <= 65_535
  ) {
    return {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      type: value.type,
      pid: value.pid as number,
      instanceId: value.instanceId,
      protocolVersion: value.protocolVersion,
      connectionToken: value.connectionToken,
      endpoint: { type: "tcp", host: endpoint.host, port: endpoint.port as number },
    };
  }
  return undefined;
}

function identityKey(entry: RegistryEntry): string {
  return `${entry.type}:${entry.pid}:${entry.instanceId}`;
}

function entryFileName(entry: RegistryEntry): string {
  const input = `${entry.type}\0${entry.pid}\0${entry.instanceId}`;
  return `${createHash("sha256").update(input, "utf8").digest("hex")}.json`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readJson(path: string): Promise<unknown> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) return undefined;
  if (process.getuid && details.uid !== process.getuid()) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readRegistryRoot(userDataPath: string): Promise<Array<RegistryEntry & { modifiedAt: number }>> {
  const endpointRoot = join(userDataPath, "agent-host", "local-endpoint");
  const entriesPath = join(endpointRoot, "entries");
  const liveEntries: Array<RegistryEntry & { modifiedAt: number }> = [];
  const legacyEntries: Array<RegistryEntry & { modifiedAt: number }> = [];

  try {
    const names = await readdir(entriesPath);
    for (const name of names) {
      if (!ENTRY_FILE.test(name)) continue;
      const path = join(entriesPath, name);
      try {
        const details = await lstat(path);
        const entry = parseRegistryEntry(await readJson(path));
        if (entry && entryFileName(entry) === name) {
          liveEntries.push({ ...entry, modifiedAt: details.mtimeMs });
        }
      } catch {
        // A malformed or concurrently removed entry must not hide valid hosts.
      }
    }
  } catch {
    // This product quality has no endpoint registry.
  }

  try {
    const legacyPath = join(endpointRoot, "metadata.json");
    const details = await lstat(legacyPath);
    const legacy = await readJson(legacyPath);
    if (Array.isArray(legacy)) {
      for (const raw of legacy) {
        const entry = parseRegistryEntry(raw);
        if (entry) legacyEntries.push({ ...entry, modifiedAt: details.mtimeMs });
      }
    }
  } catch {
    // Legacy metadata is optional.
  }

  return [...legacyEntries, ...liveEntries];
}

export async function discoverLocalEditorEndpoints(
  userDataPaths = vscodeUserDataPaths(),
): Promise<LocalEditorEndpoint[]> {
  const entries = (await Promise.all(userDataPaths.map(readRegistryRoot))).flat();
  const deduped = new Map<string, RegistryEntry & { modifiedAt: number }>();
  for (const entry of entries) deduped.set(identityKey(entry), entry);

  return [...deduped.values()]
    .filter(
      (entry): entry is RegistryEntry & {
        endpoint: { type: "socket"; path: string };
        modifiedAt: number;
      } => entry.type === "editor" && entry.endpoint.type === "socket" && isPidAlive(entry.pid),
    )
    .map((entry) => ({
      socketPath: entry.endpoint.path,
      connectionToken: entry.connectionToken,
      protocolVersion: entry.protocolVersion,
      pid: entry.pid,
      instanceId: entry.instanceId,
      modifiedAt: entry.modifiedAt,
    }));
}
