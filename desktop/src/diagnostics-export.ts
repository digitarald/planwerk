import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { LOG_BACKUPS, LOG_MAX_BYTES, redactLogText } from "../../lib/diagnostics/log.ts";

export const EXPORT_TAIL_BYTES = 256 * 1024;
const LOG_FILES = ["desktop.log", "server.log", "webview.log", "telemetry/logs.ndjson"];

export async function exportDiagnostics(dataDir: string, context: {
  runId: string;
  version: string;
  channel: string;
  state: string;
}): Promise<string> {
  const files: Record<string, { content?: string; error?: string; truncated?: boolean }> = {};
  for (const name of LOG_FILES) {
    for (let index = 0; index <= LOG_BACKUPS; index++) {
      const relative = index === 0 ? name : `${name}.${index}`;
      let file: FileHandle | undefined;
      try {
        file = await open(join(dataDir, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile()) throw new Error("Not a regular log file");
        const length = Math.min(stat.size, EXPORT_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, stat.size - length);
        let content = buffer.subarray(0, bytesRead).toString("utf8");
        const truncated = stat.size > length;
        if (truncated) content = content.slice(content.indexOf("\n") + 1);
        files[relative] = { content: redactLogText(content), truncated };
      } catch (error) {
        const absent = error instanceof Error && "code" in error && error.code === "ENOENT";
        files[relative] = { error: absent ? "not-created" : "unreadable" };
        if (!absent) console.error("[diagnostics:export] Could not read", relative, error);
      } finally {
        await file?.close();
      }
    }
  }
  const directory = join(dataDir, "diagnostics");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `diagnostics-${Date.now()}-${randomUUID()}.json`);
  await writeFile(destination, JSON.stringify({
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    ...context,
    runtime: { platform: platform(), arch: arch(), osRelease: release(), bun: process.versions.bun, node: process.versions.node },
    retention: { maxFileBytes: LOG_MAX_BYTES, backups: LOG_BACKUPS, exportTailBytes: EXPORT_TAIL_BYTES },
    privacy: "Local logs only. No database, environment dump, SDK state, or conversation files. Review before sharing; log text can contain sensitive information.",
    files,
  }, null, 2), { mode: 0o600, flag: "wx" });
  return destination;
}
