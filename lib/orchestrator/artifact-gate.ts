import type { Artifact, ArtifactType } from "../types";

export function hasReadableArtifact(
  artifacts: Artifact[] | undefined,
  type: ArtifactType
): boolean {
  return artifacts?.some(
    (artifact) =>
      artifact.type === type &&
      typeof artifact.contentRef === "string" &&
      artifact.contentRef.trim().length > 0
  ) ?? false;
}
