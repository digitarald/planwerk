import * as THREE from "three";
import type { StationId } from "@/lib/flightdeck/crew";

/**
 * Floor plan, nose at -z. Mission control is the octagonal bridge in the middle,
 * ringed by a corridor loop; joined rooms hold two stations each. The most visited
 * stations (reading, planning) sit in the nose room, one door from the bridge.
 *
 *                [ Research lab: Archive + Strategy (nose) ]
 * [ Sensor array                     ]  ┌ loop ┐  [ Engine room: Engineering + Fabricator ]
 *                                       │  ◇   │
 * [ Crew lounge                      ]  └──────┘  [ Diagnostics bay                        ]
 *                  [ Comms deck ][ airlock ][ Cargo hold ]
 */
export type WorkStationId = Exclude<StationId, "bridge" | "lounge">;
export type RoomId = "research" | "engine" | "lounge" | "diagnostics" | "sensors" | "comms" | "cargo" | "bridge";

export interface Room {
  id: RoomId;
  /** Floor outline in deck coordinates (x, z). */
  outline: Array<[number, number]>;
  doors: THREE.Vector3[];
  accent: string;
}

const WING = 4.3;
const ROW = 3.4;
const NORTH = -6.0;
const SOUTH = 6.0;
const WEST = -10.4;
const EAST_EDGE = 10.4;
const rect = (x0: number, z0: number, x1: number, z1: number): Array<[number, number]> => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const door = (x: number, z: number) => new THREE.Vector3(x, 0, z);

/** Bridge octagon. */
const BRIDGE: Array<[number, number]> = [[-2.0, -2.0], [2.0, -2.0], [2.8, -1.2], [2.8, 1.2], [2.0, 2.0], [-2.0, 2.0], [-2.8, 1.2], [-2.8, -1.2]];

export const ROOMS: Room[] = [
  { id: "research", outline: rect(-WING, -7.4, WING, -ROW), doors: [door(0, -ROW)], accent: "#2dd4bf" },
  { id: "engine", outline: rect(WING, NORTH, EAST_EDGE, 0), doors: [door(WING, -2.0)], accent: "#fb923c" },
  { id: "lounge", outline: rect(WEST, 0, -WING, SOUTH), doors: [door(-WING, 2.0)], accent: "#fda4af" },
  { id: "diagnostics", outline: rect(WING, 0, EAST_EDGE, SOUTH), doors: [door(WING, 2.0)], accent: "#4ade80" },
  { id: "sensors", outline: rect(WEST, NORTH, -WING, 0), doors: [door(-WING, -2.0)], accent: "#38bdf8" },
  { id: "comms", outline: rect(-WING, ROW, -1.0, SOUTH), doors: [door(-2.65, ROW)], accent: "#f472b6" },
  { id: "cargo", outline: rect(1.0, ROW, WING, SOUTH), doors: [door(2.65, ROW)], accent: "#a1a1aa" },
  { id: "bridge", outline: BRIDGE, doors: [door(0, -2.0), door(-2.8, 0), door(2.8, 0)], accent: "#fcd34d" },
];

export const DOOR_WIDTH = 1.4;
export const WALL_HEIGHT = 0.72;

/** Solid walls as segments; doorways on them are cut out when built. */
export const WALLS: Array<[number, number, number, number]> = [
  [-WING, NORTH - 0.4, -WING, SOUTH], [WING, NORTH - 0.4, WING, SOUTH],
  [WEST, 0, -WING, 0], [WING, 0, EAST_EDGE, 0],
  [-WING, -ROW, WING, -ROW],
  [-WING, ROW, -1.0, ROW], [1.0, ROW, WING, ROW],
  [-1.0, ROW, -1.0, SOUTH], [1.0, ROW, 1.0, SOUTH],
];

/** Bridge glass walls follow the octagon. */
export const BRIDGE_WALLS: Array<[number, number, number, number]> = BRIDGE.map(([x, z], index) => {
  const [nx, nz] = BRIDGE[(index + 1) % BRIDGE.length];
  return [x, z, nx, nz];
});

export const AIRLOCK = new THREE.Vector3(0, 0, 5.2);
export const TABLE_CENTER = new THREE.Vector3(0, 0, -0.35);
export const TABLE_RADIUS = 0.9;
export const CAPTAIN_CHAIR = new THREE.Vector3(0, 0, 1.15);

export const STATION_ACCENTS: Record<StationId, string> = {
  archive: "#2dd4bf",
  scanner: "#38bdf8",
  planning: "#a78bfa",
  engineering: "#fb923c",
  fabricator: "#fbbf24",
  diagnostics: "#4ade80",
  comms: "#f472b6",
  bridge: "#fcd34d",
  lounge: "#fda4af",
};

export const AIRLOCK_ACCENT = "#ffb224";

const STATION_POSES: Record<WorkStationId, { position: THREE.Vector3; yaw: number }> = {
  archive: { position: new THREE.Vector3(-2.3, 0, -6.0), yaw: 0 },
  planning: { position: new THREE.Vector3(2.3, 0, -5.85), yaw: 0 },
  engineering: { position: new THREE.Vector3(5.9, 0, -4.75), yaw: 0 },
  fabricator: { position: new THREE.Vector3(8.7, 0, -4.75), yaw: 0 },
  scanner: { position: new THREE.Vector3(-7.4, 0, -4.75), yaw: 0 },
  diagnostics: { position: new THREE.Vector3(7.4, 0, 4.75), yaw: Math.PI },
  comms: { position: new THREE.Vector3(-2.65, 0, 5.1), yaw: Math.PI },
};

export function stationPose(station: WorkStationId): { position: THREE.Vector3; yaw: number } {
  const pose = STATION_POSES[station];
  return { position: pose.position.clone(), yaw: pose.yaw };
}

export function stationPosition(station: WorkStationId): THREE.Vector3 {
  return stationPose(station).position;
}

const SLOT_ORDER = [0, -1, 1];

/** Standing spot `index` in front of a work station; overflow forms rows behind. */
export function workSlot(station: WorkStationId, index: number): THREE.Vector3 {
  const { position, yaw } = STATION_POSES[station];
  const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const right = new THREE.Vector3(forward.z, 0, -forward.x);
  const row = Math.floor(index / SLOT_ORDER.length);
  const reach = station === "comms" ? 1.2 : 1.3;
  return position.clone().addScaledVector(forward, reach + row * 0.95).addScaledVector(right, SLOT_ORDER[index % SLOT_ORDER.length] * 0.95);
}

/** Spots around the bridge table, far side first so faces stay visible. */
export function bridgeSlot(index: number): THREE.Vector3 {
  const angles = [-90, -130, -50, -170, -10, 150, 30];
  const degrees = angles[index % angles.length];
  const radius = TABLE_RADIUS + 0.8 + Math.floor(index / angles.length) * 0.55;
  const angle = THREE.MathUtils.degToRad(degrees);
  return new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius * 0.8).add(TABLE_CENTER);
}

export type Leisure = "pingpong-a" | "pingpong-b" | "arcade" | "chess" | "couch";
export interface LoungeSpot { position: THREE.Vector3; yaw: number; seated: boolean; leisure: Leisure }

/** Game-room furniture in deck coordinates; arcade cabinets line the east wall south of the door. */
export const LOUNGE_FURNITURE = {
  pingpong: new THREE.Vector3(-7.3, 0, 2.3),
  arcade: [new THREE.Vector3(-4.95, 0, 3.75), new THREE.Vector3(-4.95, 0, 4.85)],
  chess: new THREE.Vector3(-7.4, 0, 4.85),
  couch: new THREE.Vector3(-9.72, 0, 2.3),
} as const;

const EAST = Math.PI / 2;

/** Fill order puts the most fun spots first: ping-pong, arcade, chess, then the couch. */
export function loungeSpot(index: number): LoungeSpot {
  const { pingpong, arcade, chess, couch } = LOUNGE_FURNITURE;
  if (index < 2) {
    const side = index === 0 ? -1 : 1;
    return { position: pingpong.clone().setX(pingpong.x + side * 1.3), yaw: side < 0 ? EAST : -EAST, seated: false, leisure: index === 0 ? "pingpong-a" : "pingpong-b" };
  }
  if (index < 4) {
    return { position: arcade[index - 2].clone().setX(arcade[index - 2].x - 0.8), yaw: EAST, seated: false, leisure: "arcade" };
  }
  if (index < 6) {
    const side = index === 4 ? -1 : 1;
    return { position: chess.clone().setX(chess.x + side * 0.62), yaw: side < 0 ? EAST : -EAST, seated: true, leisure: "chess" };
  }
  const seat = Math.min(index - 6, 2);
  const position = couch.clone().setX(couch.x + 0.12).setZ(couch.z + (seat - 1) * 0.84);
  if (index >= 9) position.set(-8.6 + (index - 9) * 0.6, 0, 0.9);
  return { position, yaw: EAST, seated: index < 9, leisure: "couch" };
}

/** Where each station's name sign sits. */
export function roomLabelPoint(id: StationId): THREE.Vector3 {
  if (id === "bridge") return new THREE.Vector3(0, 0, 1.75);
  if (id === "lounge") return new THREE.Vector3(-7.3, 0, 0.55);
  const { position, yaw } = STATION_POSES[id];
  return position.clone().addScaledVector(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), 0.85);
}

function insidePolygon(outline: Array<[number, number]>, x: number, z: number): boolean {
  let result = false;
  for (let a = 0, b = outline.length - 1; a < outline.length; b = a++) {
    const [ax, az] = outline[a];
    const [bx, bz] = outline[b];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) result = !result;
  }
  return result;
}

function roomAt(point: THREE.Vector3): Room | undefined {
  return ROOMS.find((room) => insidePolygon(room.outline, point.x, point.z));
}

// ── Corridor loop around the bridge ──
const LOOP_X = 3.55;
const LOOP_Z = 2.7;
const CORNERS = [door(-LOOP_X, -LOOP_Z), door(LOOP_X, -LOOP_Z), door(LOOP_X, LOOP_Z), door(-LOOP_X, LOOP_Z)];
const PERIMETER = 4 * (LOOP_X + LOOP_Z);

/** Closest point on the loop centre line. */
function onLoop(point: THREE.Vector3): THREE.Vector3 {
  const x = THREE.MathUtils.clamp(point.x, -LOOP_X, LOOP_X);
  const z = THREE.MathUtils.clamp(point.z, -LOOP_Z, LOOP_Z);
  const toSide = [Math.abs(x + LOOP_X), Math.abs(x - LOOP_X), Math.abs(z + LOOP_Z), Math.abs(z - LOOP_Z)];
  const nearest = toSide.indexOf(Math.min(...toSide));
  if (nearest === 0) return door(-LOOP_X, z);
  if (nearest === 1) return door(LOOP_X, z);
  if (nearest === 2) return door(x, -LOOP_Z);
  return door(x, LOOP_Z);
}

/** Distance along the loop, clockwise from the north-west corner. */
function loopParameter(point: THREE.Vector3): number {
  const w = LOOP_X * 2;
  const h = LOOP_Z * 2;
  if (Math.abs(point.z + LOOP_Z) < 1e-3) return point.x + LOOP_X;
  if (Math.abs(point.x - LOOP_X) < 1e-3) return w + point.z + LOOP_Z;
  if (Math.abs(point.z - LOOP_Z) < 1e-3) return w + h + (LOOP_X - point.x);
  return 2 * w + h + (LOOP_Z - point.z);
}

function alongLoop(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
  const a = loopParameter(from);
  const b = loopParameter(to);
  const clockwise = (((b - a) % PERIMETER) + PERIMETER) % PERIMETER;
  const forward = clockwise <= PERIMETER / 2;
  const cornerParams = [0, LOOP_X * 2, LOOP_X * 2 + LOOP_Z * 2, LOOP_X * 4 + LOOP_Z * 2];
  const points: THREE.Vector3[] = [];
  const distance = forward ? clockwise : PERIMETER - clockwise;
  const passed = cornerParams
    .map((param, index) => ({ index, offset: forward ? (((param - a) % PERIMETER) + PERIMETER) % PERIMETER : (((a - param) % PERIMETER) + PERIMETER) % PERIMETER }))
    .filter((corner) => corner.offset > 1e-3 && corner.offset < distance - 1e-3)
    .sort((left, right) => left.offset - right.offset);
  for (const corner of passed) points.push(CORNERS[corner.index].clone());
  points.push(to.clone());
  return points;
}

/** Waypoints from a point out to the loop. Rooms leave by the door nearest `toward`. */
function exitChain(point: THREE.Vector3, toward: THREE.Vector3): THREE.Vector3[] {
  const inside = roomAt(point);
  if (inside) {
    const exit = inside.doors.reduce((best, candidate) => candidate.distanceTo(toward) < best.distanceTo(toward) ? candidate : best);
    const outward = onLoop(exit).sub(exit).normalize();
    return [exit.clone().addScaledVector(outward, -0.5), exit.clone().addScaledVector(outward, 0.45), onLoop(exit)];
  }
  if (Math.abs(point.x) < 1.0 && point.z > ROW) return [door(0, point.z), onLoop(door(0, LOOP_Z))];
  return [onLoop(point)];
}

/** Out through a door, around the loop, in through the other door. */
export function route(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
  const fromRoom = roomAt(from);
  if ((fromRoom && fromRoom === roomAt(to)) || from.distanceTo(to) < 0.6) return [to.clone()];
  const out = exitChain(from, to);
  const back = exitChain(to, from).reverse();
  return [...out, ...alongLoop(out[out.length - 1], back[0]).slice(0, -1), ...back, to.clone()];
}

export function yawToward(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export { LOOP_X, LOOP_Z };
