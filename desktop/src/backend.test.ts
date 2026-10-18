import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Backend } from "./backend.ts";

async function fixture() {
  const resources = await mkdtemp(join(tmpdir(), "pw-server-"));
  const backend = join(resources, "backend");
  await mkdir(backend);
  await symlink(process.execPath, join(backend, "node"));
  await writeFile(join(backend, "watch-server.cjs"), `
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== "Bearer " + process.env.PLANWERK_DESKTOP_TOKEN) {
        res.writeHead(403).end(); return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({unread: 7, open: 9, connected: true, running: 2}));
    });
    server.listen(Number(process.env.PORT), process.env.HOSTNAME);
    console.log("fixture ready", process.env.PLANWERK_RUN_ID);
    console.error("Bearer " + process.env.PLANWERK_DESKTOP_TOKEN);
  `);
  return resources;
}

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  server.close();
  await once(server, "close");
  return address.port;
}

test("owned backend becomes ready and is stopped without leaving its listener behind", async () => {
  const resources = await fixture();
  const backend = new Backend({ resources, dataDir: resources, port: await availablePort(), onExit: assert.fail, runId: "fixture-launch" });
  try {
    await backend.start();
    assert.deepEqual(await backend.status(), { unread: 7, open: 9, connected: true, running: 2 });
    assert.equal((await fetch(`${backend.origin}/api/desktop/status`)).status, 403);
    await backend.stop();
    await assert.rejects(fetch(backend.origin));
    const text = await readFile(join(resources, "server.log"), "utf8");
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(records.every((record) => record.runId === "fixture-launch"));
    assert.ok(records.some((record) => record.body === "Bearer [REDACTED]"));
    const timing = records.find((record) => record.metric === "backend.ready");
    assert.ok(timing && Number.isFinite(timing.durationMs) && timing.durationMs >= 0);
    assert.match(text, /fixture ready/);
  } finally {
    await backend.stop();
    await rm(resources, { recursive: true, force: true });
  }
});

test("port collision does not adopt or kill a server belonging to someone else", async () => {
  const unrelated = createServer((_req, res) => res.writeHead(403).end());
  unrelated.listen(0, "127.0.0.1");
  await once(unrelated, "listening");
  const address = unrelated.address();
  assert.ok(address && typeof address === "object");
  const resources = await fixture();
  const backend = new Backend({ resources, dataDir: resources, port: address.port, onExit: () => {} });
  try {
    await assert.rejects(backend.start(), /Local server stopped/);
    await backend.stop();
    assert.equal((await fetch(backend.origin)).status, 403);
  } finally {
    unrelated.close();
    await once(unrelated, "close");
    await backend.stop();
    await rm(resources, { recursive: true, force: true });
  }
});

test("watchdog reaps a server that ignores SIGTERM after the desktop parent crashes", async () => {
  const resources = await mkdtemp(join(tmpdir(), "pw-watch-"));
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(parent, "spawn");
  await cp(new URL("../watch-server.cjs", import.meta.url), join(resources, "watch-server.cjs"));
  await writeFile(join(resources, "server.js"), `
    require("node:fs").writeFileSync(${JSON.stringify(join(resources, "server.pid"))}, String(process.pid));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `);
  const watchdog = spawn(process.execPath, [join(resources, "watch-server.cjs")], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PLANWERK_PARENT_PID: String(parent.pid) },
  });
  const exited = once(watchdog, "exit", { signal: AbortSignal.timeout(10_000) });
  try {
    let serverPid: number | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        serverPid = Number(await readFile(join(resources, "server.pid"), "utf8"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await delay(50);
      }
    }
    assert.ok(serverPid);
    parent.kill("SIGKILL");
    await exited;
    await delay(100);
    assert.throws(() => process.kill(serverPid, 0), { code: "ESRCH" });
  } finally {
    parent.kill("SIGKILL");
    if (watchdog.pid) {
      try { process.kill(-watchdog.pid, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await rm(resources, { recursive: true, force: true });
  }
});
