import type { ArtifactType } from "../types.ts";

const NON_CODE_PATTERNS = [
  /^\.copilot\//,
  /\/\.copilot\//,
  /\/session-state\//,
  /\/plan\.md$/i,
  /\/review\.md$/i,
  /\/research\.md$/i,
  /\/spec\.md$/i,
  /\/specification\.md$/i,
  /\/design\.md$/i,
  /\/decision\.md$/i,
  /\/test-plan\.md$/i,
  /\.tmp$/,
  /^\/tmp\//,
];

const ARTIFACT_FILE_PATTERNS: Array<{ pattern: RegExp; type: ArtifactType }> = [
  { pattern: /(?:^|\/)plan\.md$/i, type: "plan" },
  { pattern: /(?:^|\/)review\.md$/i, type: "review" },
  { pattern: /(?:^|\/)research\.md$/i, type: "research" },
  { pattern: /(?:^|\/)spec\.md$/i, type: "spec" },
  { pattern: /(?:^|\/)specification\.md$/i, type: "spec" },
  { pattern: /(?:^|\/)design\.md$/i, type: "design" },
  { pattern: /(?:^|\/)decision\.md$/i, type: "decision" },
  { pattern: /(?:^|\/)test-plan\.md$/i, type: "test-plan" },
];

export function isNonCodeFile(filePath: string): boolean {
  return NON_CODE_PATTERNS.some((pattern) => pattern.test(filePath));
}

export function classifyArtifactFile(filePath: string): ArtifactType | null {
  for (const { pattern, type } of ARTIFACT_FILE_PATTERNS) {
    if (pattern.test(filePath)) return type;
  }
  return null;
}
