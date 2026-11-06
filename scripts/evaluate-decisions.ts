import { readFile } from "node:fs/promises";
import { z } from "zod";
import { evaluateDecisions, evaluationCaseSchema } from "../lib/decisions/evaluation.ts";

const input = process.argv[2];
if (!input || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/evaluate-decisions.ts <labeled-records.json>. Offline only; no inference is performed.");
}
const cases = z.array(evaluationCaseSchema).min(1).parse(JSON.parse(await readFile(input, "utf8")));
console.log(JSON.stringify(evaluateDecisions(cases), null, 2));
