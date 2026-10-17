import assert from "node:assert/strict";
import test from "node:test";
import { dataDirectory } from "./data-directory.ts";

test("web data stays in the checkout; desktop data has an explicit persistent location", () => {
  assert.equal(dataDirectory({}, "/project"), "/project/.planwerk");
  assert.equal(dataDirectory({ PLANWERK_DATA_DIR: "/persistent" }, "/app"), "/persistent");
  assert.throws(() => dataDirectory({ PLANWERK_DATA_DIR: "../data" }), /absolute/);
});
