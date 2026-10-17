import assert from "node:assert/strict";
import { test } from "node:test";

import { reassessAndPersistRisk } from "./risk-reassessment.ts";

test("central reassessment policy cannot persist low risk from incomplete facts", async () => {
  let assessed = false;
  let persisted: { level: string; factors: string[] } | undefined;
  const result = await reassessAndPersistRisk(
    "card-1",
    {
      cardId: "card-1",
      hostUrl: "vscode-local://desktop",
      digest: "digest-1",
      input: {
        title: "Tiny unknown change",
        filesChanged: 1,
        additions: 1,
        deletions: 0,
        factsComplete: false,
      },
    },
    async () => {
      assessed = true;
      return { level: "low", factors: ["Small change"] };
    },
    (_snapshot, level, factors) => {
      persisted = { level, factors };
      return true;
    },
  );

  assert.equal(assessed, false);
  assert.equal(result.level, "high");
  assert.deepEqual(persisted, {
    level: "high",
    factors: ["Authoritative file facts are incomplete"],
  });
});

test("shared model assessment does not share a caller's persistence authority", async () => {
    const snapshot = {
      cardId: "shared-card", hostUrl: "ws://shared", digest: "shared-facts",
      input: { title: "Tidy text", factsComplete: true, filesChanged: 1, additions: 1, deletions: 0 },
    };
    let calls = 0;
    let finish!: (value: { level: "low"; factors: string[] }) => void;
    const assess = async () => {
      calls++;
      return new Promise<{ level: "low"; factors: string[] }>((resolve) => { finish = resolve; });
    };
    let revoked = false;
    let secondWrites = 0;
    const first = reassessAndPersistRisk(snapshot.cardId, snapshot, assess, () => !revoked);
    const rejected = assert.rejects(first, /facts changed/);
    const second = reassessAndPersistRisk(snapshot.cardId, snapshot, assess, () => { secondWrites++; return true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    revoked = true;
    finish({ level: "low", factors: ["Small"] });
    await rejected;
    assert.equal((await second).level, "low");
    assert.equal(calls, 1);
    assert.equal(secondWrites, 1);
});
