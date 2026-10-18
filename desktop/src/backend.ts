import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseStatus, type InboxStatus } from "./model.ts";
import { DiagnosticLog } from "../../lib/diagnostics/log.ts";
import { captureOutput } from "./diagnostics.ts";

export interface BackendOptions {
  resources: string;
  dataDir: string;
  port: number;
  onExit: (message: string) => void;
  runId?: string;
}

export class Backend {
  readonly origin: string;
  private readonly token = randomBytes(32).toString("hex");
  private child?: ChildProcess;
  private failure?: string;
  private stopping = false;
  private readonly options: BackendOptions;

  constructor(options: BackendOptions) {
    this.options = options;
    this.origin = `http://127.0.0.1:${options.port}`;
  }

  async start(): Promise<void> {
    const startedAt = performance.now();
    const backend = join(this.options.resources, "backend");
    const log = new DiagnosticLog(
      join(this.options.dataDir, "server.log"),
      { runId: this.options.runId ?? "standalone", pid: process.pid },
      [this.token],
      undefined,
      (message) => console.error(message),
    );
    log.write({ level: "INFO", scope: "backend:lifecycle", body: "Starting local server", port: this.options.port });
    this.child = spawn(join(backend, "node"), [join(backend, "watch-server.cjs")], {
      cwd: backend,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        NODE_OPTIONS: "",
        HOSTNAME: "127.0.0.1",
        PORT: String(this.options.port),
        PLANWERK_DATA_DIR: this.options.dataDir,
        PLANWERK_DESKTOP_TOKEN: this.token,
        PLANWERK_PARENT_PID: String(process.pid),
        PLANWERK_RUN_ID: this.options.runId ?? "standalone",
        AHP_DEBUG: process.env.AHP_DEBUG ?? "1",
        PATH: `${join(backend, "bin")}:${process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"}:/opt/homebrew/bin:/usr/local/bin`,
      },
    });
    for (const [stream, level] of [[this.child.stdout, "INFO"], [this.child.stderr, "ERROR"]] as const) {
      const output = captureOutput(log, level, this.child.pid);
      stream?.on("data", (chunk: Buffer) => output.write(chunk));
      stream?.on("end", () => output.end());
    }
    this.child.on("error", (error) => this.recordFailure(error.message));
    this.child.on("exit", (code, signal) => {
      log.write({ level: this.stopping ? "INFO" : "ERROR", scope: "backend:lifecycle", body: "Local server exited", code, signal });
      if (!this.stopping) {
        this.recordFailure(`Local server stopped (${signal ?? code}). See server.log.`);
      }
    });
    const deadline = Date.now() + 30_000;
    let lastError = "Server did not become ready";
    while (Date.now() < deadline && !this.stopping) {
      if (this.failure) throw new Error(this.failure);
      try {
        await this.status();
        log.write({
          level: "INFO", scope: "performance", body: "Backend ready",
          metric: "backend.ready", durationMs: performance.now() - startedAt,
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await delay(250);
    }
    throw new Error(`Local server startup failed: ${lastError}. See server.log.`);
  }

  async status(): Promise<InboxStatus> {
    if (this.failure) throw new Error(this.failure);
    const response = await fetch(`${this.origin}/api/desktop/status`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`Local server returned HTTP ${response.status}`);
    return parseStatus(await response.json());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const pid = this.child?.pid;
    if (!pid) return;
    // The process group was created by this instance; never signal an adopted server.
    const signalGroup = (signal: NodeJS.Signals): boolean => {
      try {
        process.kill(-pid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    if (!signalGroup("SIGTERM")) {
      this.child = undefined;
      return;
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(100);
      try {
        process.kill(-pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          this.child = undefined;
          return;
        }
        throw error;
      }
    }
    signalGroup("SIGKILL");
    this.child = undefined;
  }

  private recordFailure(message: string): void {
    if (this.stopping) return;
    this.failure = message;
    console.error("[desktop:backend]", message);
    this.options.onExit(message);
  }
}
