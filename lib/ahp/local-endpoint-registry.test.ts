import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverLocalEditorEndpoints,
  vscodeUserDataPaths,
} from "./local-endpoint-registry.ts";

function registryEntryName(entry: {
  type: string;
  pid: number;
  instanceId: string;
}): string {
  const identity = `${entry.type}\0${entry.pid}\0${entry.instanceId}`;
  return `${createHash("sha256").update(identity).digest("hex")}.json`;
}

test("vscodeUserDataPaths checks Insiders before Stable on macOS", () => {
  assert.deepEqual(
    vscodeUserDataPaths({
      platform: "darwin",
      env: {},
      home: "/Users/test",
    }),
    [
      "/Users/test/Library/Application Support/Code - Insiders",
      "/Users/test/Library/Application Support/Code",
    ],
  );
});

test("vscodeUserDataPaths honors portable user data", () => {
  assert.deepEqual(
    vscodeUserDataPaths({
      platform: "linux",
      env: { VSCODE_PORTABLE: "./portable" },
      home: "/home/test",
      cwd: "/workspace",
    }),
    ["/workspace/portable/user-data"],
  );
});

test("vscodeUserDataPaths honors an explicit AHP registry override", () => {
  assert.deepEqual(
    vscodeUserDataPaths({
      platform: "linux",
      env: { AHP_VSCODE_USER_DATA_DIR: "./custom-data" },
      home: "/home/test",
      cwd: "/workspace",
    }),
    ["/workspace/custom-data"],
  );
});

test("discoverLocalEditorEndpoints reads schema-v2 editor entries", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "planwerk-ahp-registry-"));
  const entriesPath = join(userDataPath, "agent-host", "local-endpoint", "entries");
  await mkdir(entriesPath, { recursive: true });

  const entry = {
    schemaVersion: 2,
    type: "editor",
    pid: process.pid,
    instanceId: "editor-instance",
    protocolVersion: "1.0.0",
    connectionToken: "secret-token",
    endpoint: { type: "socket", path: "/tmp/editor.sock" },
  };
  await writeFile(
    join(entriesPath, registryEntryName(entry)),
    JSON.stringify(entry),
    { mode: 0o600 },
  );

  try {
    assert.deepEqual(
      (await discoverLocalEditorEndpoints([userDataPath])).map((endpoint) => ({
        socketPath: endpoint.socketPath,
        connectionToken: endpoint.connectionToken,
        protocolVersion: endpoint.protocolVersion,
        pid: endpoint.pid,
        instanceId: endpoint.instanceId,
      })),
      [{
        socketPath: "/tmp/editor.sock",
        connectionToken: "secret-token",
        protocolVersion: "1.0.0",
        pid: process.pid,
        instanceId: "editor-instance",
      }],
    );
  } finally {
    await rm(userDataPath, { recursive: true });
  }
});

test("discoverLocalEditorEndpoints ignores standalone, misnamed, and dead entries", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "planwerk-ahp-registry-"));
  const entriesPath = join(userDataPath, "agent-host", "local-endpoint", "entries");
  await mkdir(entriesPath, { recursive: true });
  const entries = [
    {
      schemaVersion: 2,
      type: "standalone",
      pid: process.pid,
      instanceId: "standalone",
      protocolVersion: "1.0.0",
      connectionToken: "token",
      endpoint: { type: "tcp", host: "localhost", port: 8082 },
    },
    {
      schemaVersion: 2,
      type: "editor",
      pid: 2_147_483_647,
      instanceId: "dead",
      protocolVersion: "1.0.0",
      connectionToken: "token",
      endpoint: { type: "socket", path: "/tmp/dead.sock" },
    },
  ];
  for (const entry of entries) {
    await writeFile(
      join(entriesPath, registryEntryName(entry)),
      JSON.stringify(entry),
    );
  }
  await writeFile(
    join(entriesPath, `${"0".repeat(64)}.json`),
    JSON.stringify({
      ...entries[1],
      pid: process.pid,
      instanceId: "misnamed",
    }),
  );

  try {
    assert.deepEqual(await discoverLocalEditorEndpoints([userDataPath]), []);
  } finally {
    await rm(userDataPath, { recursive: true });
  }
});

test("discoverLocalEditorEndpoints lets a live entry replace legacy metadata", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "planwerk-ahp-registry-"));
  const endpointRoot = join(userDataPath, "agent-host", "local-endpoint");
  const entriesPath = join(endpointRoot, "entries");
  await mkdir(entriesPath, { recursive: true });

  const entry = {
    schemaVersion: 2,
    type: "editor",
    pid: process.pid,
    instanceId: "shared-identity",
    protocolVersion: "1.0.0",
    connectionToken: "live-token",
    endpoint: { type: "socket", path: "/tmp/live.sock" },
  };
  await writeFile(
    join(endpointRoot, "metadata.json"),
    JSON.stringify([{
      ...entry,
      connectionToken: "legacy-token",
      endpoint: { type: "socket", path: "/tmp/legacy.sock" },
    }]),
  );
  await writeFile(
    join(entriesPath, registryEntryName(entry)),
    JSON.stringify(entry),
  );

  try {
    const discovered = await discoverLocalEditorEndpoints([userDataPath]);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0]?.socketPath, "/tmp/live.sock");
    assert.equal(discovered[0]?.connectionToken, "live-token");
  } finally {
    await rm(userDataPath, { recursive: true });
  }
});
