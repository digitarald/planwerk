import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const settingsSchema = z.strictObject({
  endpoint: z.string().trim().min(1),
  deployment: z.string().trim().min(1),
});

export function usesDecideConfiguration(): boolean {
  const source = process.env.PLANWERK_DECISION_CONFIG_SOURCE;
  if (source !== undefined && source !== "decide") {
    throw new Error("PLANWERK_DECISION_CONFIG_SOURCE must be decide when configured.");
  }
  return source === "decide";
}

export function savedDecideConfiguration(): { endpoint?: string; deployment?: string } {
  const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "decide", "config.json");
  let contents: Buffer;
  try {
    contents = readFileSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw new Error("Decision-model setup cannot read the saved decide configuration.");
  }
  if (contents.byteLength > 128 * 1024) throw new Error("Saved decide configuration exceeds its size limit.");
  try {
    return settingsSchema.parse(JSON.parse(contents.toString("utf8")));
  } catch {
    throw new Error("Saved decide configuration is invalid; repair it using the skill's setup command.");
  }
}

export async function readDecideKeychainCredential(endpoint: string): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("The decide Keychain credential is available only on macOS; configure a server-side credential.");
  }
  const service = `decide:${new URL(endpoint).hostname.split(".")[0]}`;
  try {
    const result = await execute("/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", "api-key", "-w"],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 });
    const credential = result.stdout.trim();
    if (!credential || !/^[!-~]+$/.test(credential)) throw new Error("Invalid credential.");
    return credential;
  } catch {
    throw new Error("Decision-model setup cannot read the decide Keychain credential. Unlock or allow access locally, or configure a server-side credential.");
  }
}
