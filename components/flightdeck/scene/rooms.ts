import * as THREE from "three";
import { hullShape } from "./hull";
import { box, canvasTexture, cylinder, glow, mesh, plastic, sphere, uniqueMaterial } from "./kit";
import {
  AIRLOCK_ACCENT, BRIDGE_WALLS, DOOR_WIDTH, LOOP_X, LOOP_Z, ROOMS, WALL_HEIGHT, WALLS, type Room,
} from "./layout";

export interface Rooms {
  root: THREE.Group;
  update(dt: number, time: number, motion: boolean): void;
}

const WALL = "#e7ebf5";
const TRIM = "#9aa6d6";
const SHELF = "#94a3b8";

function lightPoolTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (context, size) => {
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255, 236, 205, 0.16)");
    gradient.addColorStop(0.55, "rgba(255, 236, 205, 0.07)");
    gradient.addColorStop(1, "rgba(255, 236, 205, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  });
}

function roomFloorTexture(): THREE.CanvasTexture {
  const texture = canvasTexture(256, (context, size) => {
    context.fillStyle = "#5b6594";
    context.fillRect(0, 0, size, size);
    context.strokeStyle = "#505a88";
    context.lineWidth = 4;
    context.strokeRect(2, 2, size - 4, size - 4);
    context.strokeStyle = "rgba(255,255,255,0.06)";
    context.lineWidth = 2;
    context.strokeRect(14, 14, size - 28, size - 28);
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / 1.6, 1 / 1.6);
  return texture;
}

const HULL_OUTLINE = () => hullShape(-0.12).getPoints(160);

function insideHull(outline: THREE.Vector2[], x: number, y: number): boolean {
  let result = false;
  for (let a = 0, b = outline.length - 1; a < outline.length; b = a++) {
    const pa = outline[a];
    const pb = outline[b];
    if ((pa.y > y) !== (pb.y > y) && x < ((pb.x - pa.x) * (y - pa.y)) / (pb.y - pa.y) + pa.x) result = !result;
  }
  return result;
}

/** Room floor; vertices outside the hull snap onto it so corner rooms follow its curve. */
function roomFloor(room: Room, material: THREE.Material, outline: THREE.Vector2[]): THREE.Mesh {
  let geometry: THREE.BufferGeometry;
  if (room.outline.length === 4) {
    const xs = room.outline.map(([x]) => x);
    const zs = room.outline.map(([, z]) => z);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const inset = 0.09;
    geometry = new THREE.PlaneGeometry(x1 - x0 - inset * 2, z1 - z0 - inset * 2, 24, 24);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
  } else {
    const shape = new THREE.Shape(room.outline.map(([x, z]) => new THREE.Vector2(x, -z)));
    geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(-Math.PI / 2);
  }
  const position = geometry.attributes.position;
  const probe = new THREE.Vector2();
  for (let index = 0; index < position.count; index++) {
    probe.set(position.getX(index), -position.getZ(index));
    if (insideHull(outline, probe.x, probe.y)) continue;
    let best = outline[0];
    for (const point of outline) if (point.distanceToSquared(probe) < best.distanceToSquared(probe)) best = point;
    position.setXYZ(index, best.x, 0, -best.y);
  }
  // Planar UVs in world units so tiles line up across rooms.
  const uv = geometry.attributes.uv;
  for (let index = 0; index < position.count; index++) uv.setXY(index, position.getX(index), -position.getZ(index));
  const floor = mesh(geometry, material, [0, 0.006, 0], false);
  floor.receiveShadow = true;
  return floor;
}

/** Split a wall at any doorway lying on it. */
function openings(x0: number, z0: number, x1: number, z1: number, doors: THREE.Vector3[]): Array<[number, number, number, number]> {
  const length = Math.hypot(x1 - x0, z1 - z0);
  const dx = (x1 - x0) / length;
  const dz = (z1 - z0) / length;
  const cuts = doors
    .map((door) => ({ along: (door.x - x0) * dx + (door.z - z0) * dz, off: Math.abs((door.x - x0) * dz - (door.z - z0) * dx) }))
    .filter((cut) => cut.off < 0.05 && cut.along > 0 && cut.along < length)
    .map((cut) => cut.along)
    .sort((a, b) => a - b);
  const pieces: Array<[number, number, number, number]> = [];
  let start = 0;
  for (const cut of [...cuts, length + DOOR_WIDTH / 2]) {
    const end = Math.min(length, cut - DOOR_WIDTH / 2);
    if (end - start > 0.05) pieces.push([x0 + dx * start, z0 + dz * start, x0 + dx * end, z0 + dz * end]);
    start = cut + DOOR_WIDTH / 2;
  }
  return pieces;
}

function wallSegment(x0: number, z0: number, x1: number, z1: number, material: THREE.Material, trim: THREE.Material): THREE.Object3D[] {
  const length = Math.hypot(x1 - x0, z1 - z0);
  if (length < 0.05) return [];
  const yaw = -Math.atan2(z1 - z0, x1 - x0);
  const center = new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2);
  const body = box(length, WALL_HEIGHT, 0.18, material, [center.x, WALL_HEIGHT / 2, center.z], 0.05);
  body.rotation.y = yaw;
  const cap = box(length + 0.02, 0.06, 0.24, trim, [center.x, WALL_HEIGHT + 0.01, center.z], 0.03);
  cap.rotation.y = yaw;
  return [body, cap];
}

export function buildRooms(): Rooms {
  const root = new THREE.Group();
  const blinkers: Array<{ mesh: THREE.Mesh; phase: number; speed: number }> = [];
  const doorLights: THREE.MeshStandardMaterial[] = [];
  const wallMaterial = plastic(WALL, { roughness: 0.45 });
  const trimMaterial = plastic(TRIM, { metalness: 0.3, roughness: 0.35 });

  const floorMaterial = new THREE.MeshStandardMaterial({ map: roomFloorTexture(), roughness: 0.75 });
  const outline = HULL_OUTLINE();
  // Warm ceiling-light pools are painted onto the floor instead of using a point light per room.
  const poolMaterial = new THREE.MeshBasicMaterial({ map: lightPoolTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  for (const room of ROOMS) {
    root.add(roomFloor(room, floorMaterial, outline));
    const xs = room.outline.map(([x]) => x);
    const zs = room.outline.map(([, z]) => z);
    const width = Math.max(...xs) - Math.min(...xs);
    const depth = Math.max(...zs) - Math.min(...zs);
    const pool = mesh(new THREE.PlaneGeometry(width * 0.95, depth * 0.95), poolMaterial, [(Math.min(...xs) + Math.max(...xs)) / 2, 0.014, (Math.min(...zs) + Math.max(...zs)) / 2], false);
    pool.rotation.x = -Math.PI / 2;
    pool.receiveShadow = false;
    root.add(pool);
  }

  // Walls, with doorways cut where a door sits on the segment.
  const doors = ROOMS.flatMap((room) => room.doors);
  for (const [x0, z0, x1, z1] of WALLS) {
    for (const piece of openings(x0, z0, x1, z1, doors)) root.add(...wallSegment(...piece, wallMaterial, trimMaterial));
  }

  // The bridge is walled in glass so mission control stays visible from everywhere.
  const glass = new THREE.MeshPhysicalMaterial({ color: "#bfe9ff", transparent: true, opacity: 0.28, roughness: 0.05, metalness: 0.1, depthWrite: false });
  const frameMaterial = plastic("#dfe5f0", { roughness: 0.4 });
  for (const [x0, z0, x1, z1] of BRIDGE_WALLS) {
    for (const [ax, az, bx, bz] of openings(x0, z0, x1, z1, ROOMS.find((room) => room.id === "bridge")!.doors)) {
      const length = Math.hypot(bx - ax, bz - az);
      const yaw = -Math.atan2(bz - az, bx - ax);
      const pane = mesh(new THREE.BoxGeometry(length, 0.62, 0.05), glass, [(ax + bx) / 2, 0.35, (az + bz) / 2], false);
      pane.rotation.y = yaw;
      root.add(pane);
      const rail = box(length + 0.04, 0.06, 0.12, frameMaterial, [(ax + bx) / 2, 0.68, (az + bz) / 2], 0.03);
      rail.rotation.y = yaw;
      const base = box(length + 0.04, 0.08, 0.14, frameMaterial, [(ax + bx) / 2, 0.04, (az + bz) / 2], 0.03);
      base.rotation.y = yaw;
      root.add(rail, base);
      for (const [px, pz] of [[ax, az], [bx, bz]]) root.add(cylinder(0.06, 0.06, 0.72, "#dfe5f0", [px, 0.36, pz], 10));
    }
  }

  // Door frames: the one place a room shows its color. One glow material per room keeps
  // each room's frame to a single draw once static geometry is merged.
  const roomGlow = new Map<string, THREE.MeshStandardMaterial>();
  for (const room of ROOMS.filter((candidate) => candidate.id !== "bridge")) for (const doorway of room.doors) {
    const accent = room.accent;
    let glowMaterial = roomGlow.get(room.id);
    if (!glowMaterial) {
      glowMaterial = uniqueMaterial(accent, { emissive: accent, emissiveIntensity: 0.9 });
      roomGlow.set(room.id, glowMaterial);
      doorLights.push(glowMaterial);
    }
    const frame = new THREE.Group();
    frame.position.copy(doorway);
    // Frames are built along x; rotate for doors on north-south walls.
    if (WALLS.some(([x0, , x1]) => Math.abs(x0 - x1) < 0.01 && Math.abs(x0 - doorway.x) < 0.01)) frame.rotation.y = Math.PI / 2;
    for (const side of [-1, 1]) {
      frame.add(box(0.24, 1.15, 0.3, "#cfd6ea", [side * (DOOR_WIDTH / 2 + 0.02), 0.575, 0], 0.06));
      frame.add(box(0.06, 0.8, 0.32, glowMaterial, [side * (DOOR_WIDTH / 2 - 0.1), 0.6, 0], 0.02));
    }
    frame.add(box(DOOR_WIDTH + 0.48, 0.1, 0.22, "#cfd6ea", [0, 1.18, 0], 0.04));
    frame.add(box(DOOR_WIDTH - 0.1, 0.04, 0.24, glowMaterial, [0, 1.12, 0], 0.015));
    const threshold = mesh(new THREE.PlaneGeometry(DOOR_WIDTH - 0.1, 0.28), plastic("#2e345a", { roughness: 0.6 }), [0, 0.012, 0], false);
    threshold.rotation.x = -Math.PI / 2;
    frame.add(threshold);
    root.add(frame);
  }

  // Corridor guide lights running down the centre lines, as one instanced draw.
  const guideSpots: Array<[number, number, "x" | "z"]> = [];
  const guide = (x: number, z: number, along: "x" | "z") => { guideSpots.push([x, z, along]); };
  for (let x = -LOOP_X; x <= LOOP_X + 0.01; x += 0.55) { guide(x, -LOOP_Z, "x"); guide(x, LOOP_Z, "x"); }
  for (let z = -LOOP_Z + 0.55; z < LOOP_Z - 0.2; z += 0.55) { guide(-LOOP_X, z, "z"); guide(LOOP_X, z, "z"); }
  for (let z = LOOP_Z + 0.6; z <= 4.6; z += 0.55) guide(0, z, "z");
  const guideGeometry = new THREE.PlaneGeometry(0.3, 0.06).rotateX(-Math.PI / 2);
  const guides = new THREE.InstancedMesh(guideGeometry, new THREE.MeshBasicMaterial({ color: "#ffffff" }), guideSpots.length);
  const guideMatrix = new THREE.Matrix4();
  guideSpots.forEach(([x, z, along], index) => {
    guideMatrix.makeRotationY(along === "z" ? Math.PI / 2 : 0).setPosition(x, 0.008, z);
    guides.setMatrixAt(index, guideMatrix);
  });
  root.add(guides);
  const guideDim = new THREE.Color("#3a4374");
  const guideBright = new THREE.Color("#b4c2ff");
  const guideColor = new THREE.Color();

  // Pipes and conduits hugging the inside of the hull wall.
  const pipeMaterial = plastic("#aab3d4", { metalness: 0.45, roughness: 0.3 });
  const conduitMaterial = plastic("#ff8a3d", { roughness: 0.4 });
  const along = (inset: number, height: number, count: number) =>
    hullShape(-inset).getSpacedPoints(count).slice(0, -1).map((point) => new THREE.Vector3(point.x, height, -point.y));
  for (const [inset, radius, material, height] of [[0.16, 0.075, pipeMaterial, 0.5], [0.13, 0.04, conduitMaterial, 0.26]] as const) {
    root.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(along(inset, height, 160), true), 200, radius, 6, true), material));
  }

  // Props against room walls.
  const prop = (x: number, z: number, yaw: number, build: (group: THREE.Group) => void) => {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = yaw;
    build(group);
    root.add(group);
  };
  const EAST = Math.PI / 2;
  const WEST = -Math.PI / 2;
  // Research lab (nose): server rack and bookshelf on the side walls.
  prop(3.95, -4.4, WEST, (group) => {
    group.add(box(0.6, 1.3, 0.45, "#334155", [0, 0.65, 0], 0.06));
    for (let row = 0; row < 6; row++) {
      const led = sphere(0.03, uniqueMaterial("#2dd4bf", { emissive: "#2dd4bf", emissiveIntensity: 1 }), [-0.18 + (row % 2) * 0.12, 0.3 + row * 0.17, 0.23], 8);
      blinkers.push({ mesh: led, phase: row, speed: 3 + row });
      group.add(led);
    }
  });
  prop(-3.95, -4.6, EAST, (group) => {
    group.add(box(1.6, 0.06, 0.36, SHELF, [0, 0.55, 0], 0.02), box(1.6, 0.06, 0.36, SHELF, [0, 0.95, 0], 0.02));
    for (const x of [-0.78, 0.78]) group.add(box(0.05, 1.0, 0.36, SHELF, [x, 0.5, 0], 0.02));
    ["#a78bfa", "#2dd4bf", "#f472b6", "#fbbf24", "#38bdf8", "#4ade80"].forEach((color, index) => group.add(box(0.12, 0.28, 0.24, color, [-0.6 + index * 0.2, 0.73, 0], 0.02)));
  });
  // Engine room: parts shelf, crates and a coolant tank.
  prop(4.7, -0.75, Math.PI, (group) => {
    group.add(box(0.9, 0.06, 0.38, SHELF, [0, 0.45, 0], 0.02), box(0.9, 0.06, 0.38, SHELF, [0, 0.9, 0], 0.02));
    for (const x of [-0.42, 0.42]) group.add(box(0.05, 0.95, 0.38, SHELF, [x, 0.475, 0], 0.02));
    group.add(box(0.22, 0.2, 0.22, "#fb923c", [-0.2, 0.58, 0], 0.04), sphere(0.11, "#94a3b8", [0.18, 0.59, 0], 12), box(0.3, 0.14, 0.2, "#38bdf8", [0.05, 1.0, 0], 0.03));
  });
  prop(9.85, -1.4, WEST, (group) => {
    group.add(box(0.5, 0.42, 0.5, "#d97706", [0, 0.21, 0], 0.05), box(0.42, 0.36, 0.42, "#f59e0b", [0.05, 0.6, 0.02], 0.05));
    group.add(cylinder(0.2, 0.2, 0.62, "#64748b", [0.75, 0.31, 0], 16), cylinder(0.21, 0.21, 0.06, "#fbbf24", [0.75, 0.5, 0], 16));
  });
  prop(7.3, -1.0, Math.PI, (group) => {
    group.add(cylinder(0.38, 0.38, 1.1, "#cbd5e1", [0, 0.55, 0], 24), cylinder(0.4, 0.4, 0.08, "#38bdf8", [0, 0.8, 0], 24));
    const gauge = sphere(0.09, uniqueMaterial("#0f172a", { emissive: "#38bdf8", emissiveIntensity: 0.8 }), [0, 0.55, 0.36], 12);
    blinkers.push({ mesh: gauge, phase: 0, speed: 1.4 });
    group.add(gauge);
  });
  // Sensor array: star chart table and a telescope by the hull.
  prop(-7.3, -0.75, Math.PI, (group) => {
    group.add(box(0.7, 0.55, 0.45, "#cbd5e1", [0, 0.275, 0], 0.06));
    const chart = mesh(new THREE.PlaneGeometry(0.6, 0.36), uniqueMaterial("#0b1d33", { emissive: "#38bdf8", emissiveIntensity: 0.7 }), [0, 0.56, 0], false);
    chart.rotation.x = -Math.PI / 2;
    blinkers.push({ mesh: chart, phase: 2, speed: 0.7 });
    group.add(chart);
  });
  prop(-9.85, -1.8, EAST, (group) => {
    group.add(cylinder(0.04, 0.06, 0.7, "#64748b", [0, 0.35, 0], 8));
    const tube = cylinder(0.09, 0.12, 0.8, "#e2e8f0", [0, 0.8, 0.15], 14);
    tube.rotation.x = -0.9;
    group.add(tube);
  });
  // Diagnostics bay: tool lockers on the east wall and a test bench.
  prop(9.95, 2.0, WEST, (group) => {
    for (const x of [-0.24, 0.24]) {
      group.add(box(0.44, 1.05, 0.36, "#cbd5e1", [x, 0.525, 0], 0.05));
      group.add(box(0.06, 0.18, 0.02, "#475569", [x + 0.12, 0.62, 0.19], 0.01));
    }
  });
  prop(9.3, 0.55, Math.PI, (group) => {
    group.add(box(1.3, 0.7, 0.5, "#c9cfe2", [0, 0.35, 0], 0.06));
    const scope = mesh(new THREE.PlaneGeometry(0.34, 0.2), uniqueMaterial("#052e16", { emissive: "#4ade80", emissiveIntensity: 0.7 }), [0.3, 0.71, 0], false);
    scope.rotation.x = -Math.PI / 2;
    blinkers.push({ mesh: scope, phase: 1, speed: 4 });
    group.add(scope, box(0.3, 0.16, 0.24, "#4ade80", [-0.3, 0.78, 0], 0.04));
  });
  // Comms deck: antenna relay.
  prop(-1.35, 5.4, WEST, (group) => {
    group.add(box(0.5, 0.5, 0.4, "#e2e8f0", [0, 0.25, 0], 0.06), cylinder(0.03, 0.03, 0.9, "#94a3b8", [0, 0.95, 0], 8));
    const tip = sphere(0.06, uniqueMaterial("#f472b6", { emissive: "#f472b6", emissiveIntensity: 1 }), [0, 1.42, 0], 10);
    blinkers.push({ mesh: tip, phase: 0, speed: 5 });
    group.add(tip);
  });
  // Cargo hold: stacked crates and a loader.
  prop(2.65, 4.8, Math.PI, (group) => {
    const crates: Array<[number, number, number, string]> = [[-0.9, 0, 0, "#d97706"], [-0.3, 0, 0.1, "#0ea5e9"], [0.35, 0, -0.05, "#a3a3a3"], [-0.6, 1, 0.05, "#f59e0b"], [0.05, 1, 0, "#22c55e"], [0.95, 0, 0.05, "#d97706"]];
    for (const [x, level, z, color] of crates) {
      group.add(box(0.55, 0.5, 0.55, color, [x, 0.25 + level * 0.5, z], 0.05));
      group.add(box(0.57, 0.06, 0.08, "#1f2937", [x, 0.32 + level * 0.5, z + 0.27], 0.01));
    }
  });
  prop(2.0, 3.95, 0, (group) => {
    group.add(box(0.5, 0.18, 0.7, "#facc15", [0, 0.16, 0], 0.05), box(0.08, 0.7, 0.08, "#475569", [0, 0.5, 0.3], 0.02));
    for (const x of [-0.2, 0.2]) group.add(cylinder(0.08, 0.08, 0.06, "#1f2937", [x, 0.06, 0.25], 10).rotateZ(Math.PI / 2));
  });
  // Airlock: spacesuit lockers either side of the passage.
  for (const side of [-1, 1]) {
    prop(side * 0.74, 4.0, side < 0 ? EAST : WEST, (group) => {
      group.add(box(0.52, 1.2, 0.34, "#dfe5f0", [0, 0.6, 0], 0.06));
      group.add(box(0.36, 0.5, 0.02, "#0f172a", [0, 0.8, 0.18], 0.02));
      group.add(sphere(0.12, glow("#bfe9ff", 0.85), [0, 0.84, 0.18], 14));
    });
  }
  // Mission control: side consoles inside the glass.
  for (const side of [-1, 1]) {
    prop(side * 2.2, -1.45, Math.atan2(-side * 2.2, 1.1), (group) => {
      group.add(box(0.85, 0.62, 0.42, "#2c3360", [0, 0.31, 0], 0.08));
      const panel = mesh(new THREE.PlaneGeometry(0.7, 0.28), uniqueMaterial("#0c1229", { emissive: side < 0 ? "#38bdf8" : "#fcd34d", emissiveIntensity: 0.6 }), [0, 0.64, 0.08], false);
      panel.rotation.x = -Math.PI / 2 + 0.4;
      blinkers.push({ mesh: panel, phase: side, speed: 1.2 });
      group.add(panel);
    });
  }
  const airlockSign = box(1.0, 0.06, 0.3, uniqueMaterial(AIRLOCK_ACCENT, { emissive: AIRLOCK_ACCENT, emissiveIntensity: 0.8 }), [0, 0.74, 5.95], 0.02);
  doorLights.push(airlockSign.material as THREE.MeshStandardMaterial);
  root.add(airlockSign);

  return {
    root,
    update(_dt, time, motion) {
      for (let index = 0; index < guideSpots.length; index++) {
        const wave = (Math.sin(index * 0.45 - time * 3) + 1) / 2;
        guides.setColorAt(index, guideColor.lerpColors(guideDim, guideBright, motion ? wave ** 6 : 0.2));
      }
      guides.instanceColor!.needsUpdate = true;
      for (const blinker of blinkers) {
        const value = (Math.sin(time * blinker.speed + blinker.phase) + 1) / 2;
        (blinker.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = motion ? 0.35 + value * 0.9 : 0.6;
      }
      doorLights.forEach((light, index) => {
        light.emissiveIntensity = motion ? 0.75 + Math.sin(time * 1.4 + index * 0.7) * 0.2 : 0.85;
      });
    },
  };
}
