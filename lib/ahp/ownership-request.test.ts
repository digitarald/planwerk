import assert from "node:assert/strict";
import test from "node:test";
import { fetchOwnership, recoverOwnership } from "./ownership-request.ts";

const ownership = {
  sessionUri: "a", quarantined: true, revision: 2,
  owner: { hostId: "one", label: "VS Code local" },
  conflictingHost: { hostId: "two", label: "ws://localhost:4000/" },
  hosts: [{ hostId: "one", label: "VS Code local" }, { hostId: "two", label: "ws://localhost:4000/" }],
};
test("diagnostics and confirmation use opaque known host IDs and a revision fence", async () => {
  const signal = new AbortController().signal;
  const diagnostic = await fetchOwnership("a", signal, async (url, options) => {
    assert.match(String(url), /ownership\?sessionUri=a$/);
    assert.equal(options?.signal, signal);
    return Response.json(ownership);
  });
  assert.equal(diagnostic.quarantined, true);
  const result = await recoverOwnership("a", "two", 2, signal, async (_url, options) => {
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(options?.body as string), { sessionUri: "a", hostId: "two", expectedRevision: 2, confirm: true });
    return Response.json({ success: true, ownership: { ...ownership, quarantined: false, revision: 3 } });
  });
  assert.equal(result.quarantined, false);
});
test("stale, in-flight and invalid diagnostics never look like successful recovery", async () => {
  const signal = new AbortController().signal;
  for (const [reason, message] of [["stale", /Reload the choices/], ["in-flight", /still running or unresolved/]] as const) {
    await assert.rejects(recoverOwnership("a", "two", 2, signal, async () =>
      Response.json({ success: false, reason }, { status: 409 })), message);
  }
  await assert.rejects(fetchOwnership("a", signal, async () => Response.json({ ...ownership, sessionUri: "other" })), /invalid/);
  await assert.rejects(recoverOwnership("a", "two", 2, signal, async () => Response.json({ success: true, ownership: null })), /unavailable/);
});
