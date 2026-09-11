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
