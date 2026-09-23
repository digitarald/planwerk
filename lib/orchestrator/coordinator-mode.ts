export const COORDINATOR_MODES = [
  "observe",
  "verify",
  "coordinate",
] as const;

export type CoordinatorMode = (typeof COORDINATOR_MODES)[number];

export type CoordinatorCapability =
  | "observe"
  | "verify"
  | "review-edits"
  | "interact"
  | "advance";

export interface CoordinatorReviewPolicy {
  independent: boolean;
  allowEdits: boolean;
}

export const DEFAULT_COORDINATOR_MODE: CoordinatorMode = "observe";

export const COORDINATOR_MODE_META: Record<
  CoordinatorMode,
  {
    label: string;
    shortDescription: string;
    description: string;
  }
> = {
  observe: {
    label: "Observe",
    shortDescription: "Labels risk and surfaces blockers. Never touches sessions.",
    description:
      "Labels risk and surfaces blockers. Never starts work or touches sessions.",
  },
  verify: {
    label: "Verify",
    shortDescription:
      "Runs checks and independent reviews. Never touches primary sessions.",
    description:
      "Runs checks and independent reviews, but never responds to or advances sessions.",
  },
  coordinate: {
    label: "Coordinate",
    shortDescription: "May respond and advance after gates pass.",
    description:
      "May respond to sessions and move work after required gates pass.",
  },
};

const CAPABILITY_MINIMUM_MODE: Record<
  CoordinatorCapability,
  CoordinatorMode
> = {
  observe: "observe",
  verify: "verify",
  "review-edits": "coordinate",
  interact: "coordinate",
  advance: "coordinate",
};

const MODE_RANK: Record<CoordinatorMode, number> = {
  observe: 0,
  verify: 1,
  coordinate: 2,
};

export function isCoordinatorMode(value: unknown): value is CoordinatorMode {
  return (
    typeof value === "string" &&
    (COORDINATOR_MODES as readonly string[]).includes(value)
  );
}

export function coordinatorModeAllows(
  mode: CoordinatorMode,
  capability: CoordinatorCapability
): boolean {
  return MODE_RANK[mode] >= MODE_RANK[CAPABILITY_MINIMUM_MODE[capability]];
}

export function isCoordinatorModeEscalation(
  current: CoordinatorMode,
  next: CoordinatorMode
): boolean {
  return MODE_RANK[next] > MODE_RANK[current];
}

export function coordinatorReviewPolicy(
  mode: CoordinatorMode,
): CoordinatorReviewPolicy {
  return {
    independent: !coordinatorModeAllows(mode, "interact"),
    allowEdits: coordinatorModeAllows(mode, "review-edits"),
  };
}
