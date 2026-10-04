import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateIncompatibleProtocolVersions,
  allDesktopCandidatesProtocolIncompatible,
  selectDesktopSocket,
} from "./endpoint-selection.ts";

test("desktop socket selection prefers the largest catalog", () => {
  const selected = selectDesktopSocket([
    { socketPath: "/tmp/new-empty.sock", modifiedAt: 30, sessionCount: 0, protocolVersion: "1.0.0" },
    { socketPath: "/tmp/desktop.sock", modifiedAt: 10, sessionCount: 234, protocolVersion: "1.0.0" },
  ]);
  assert.equal(selected?.socketPath, "/tmp/desktop.sock");
});

test("desktop socket selection has deterministic tie-breakers", () => {
  const selected = selectDesktopSocket([
    { socketPath: "/tmp/z.sock", modifiedAt: 20, sessionCount: 5, protocolVersion: "1.0.0" },
    { socketPath: "/tmp/b.sock", modifiedAt: 30, sessionCount: 5, protocolVersion: "1.0.0" },
    { socketPath: "/tmp/a.sock", modifiedAt: 30, sessionCount: 5, protocolVersion: "1.0.0" },
  ]);
  assert.equal(selected?.socketPath, "/tmp/a.sock");
});

test("desktop incompatibility diagnostics aggregate and de-duplicate host versions", () => {
  assert.deepEqual(
    aggregateIncompatibleProtocolVersions([undefined, ["0.8.0"], ["0.8.0", "1.0.0"]]),
    ["0.8.0", "1.0.0"],
  );
});

test("desktop incompatibility diagnostics preserve a mismatch without version data", () => {
  assert.deepEqual(aggregateIncompatibleProtocolVersions([undefined, []]), []);
  assert.equal(aggregateIncompatibleProtocolVersions([undefined]), undefined);
});

test("desktop discovery reports versions only when every candidate proved incompatible", () => {
  assert.equal(allDesktopCandidatesProtocolIncompatible([["0.8.0"], []]), true);
  assert.equal(allDesktopCandidatesProtocolIncompatible([["0.8.0"], undefined]), false);
  assert.equal(allDesktopCandidatesProtocolIncompatible([]), false);
});
