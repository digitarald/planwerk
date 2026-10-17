import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claimInstance } from "./instance.ts";

test("second launch activates the first instance without starting a second server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pw-"));
  const path = join(directory, "app.sock");
  let activated = 0;
  const first = await claimInstance(path, () => activated++);
  try {
    assert.ok(first);
    assert.equal(await claimInstance(path, () => assert.fail("second instance became owner")), null);
    assert.equal(activated, 1);
  } finally {
    first?.close();
    if (first) await once(first, "close");
    await rm(directory, { recursive: true, force: true });
  }
});

test("a regular file is never deleted during single-instance recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pw-"));
  const path = join(directory, "app.sock");
  try {
    await writeFile(path, "preserve");
    await assert.rejects(claimInstance(path, () => {}), /non-socket/);
    assert.equal(await readFile(path, "utf8"), "preserve");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
