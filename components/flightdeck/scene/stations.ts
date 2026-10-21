import * as THREE from "three";
import type { StationId } from "@/lib/flightdeck/crew";
import { markDynamic } from "./bake";
import { box, canvasTexture, cylinder, glow, mesh, plastic, roundedBox, sphere, uniqueMaterial } from "./kit";
import {
  CAPTAIN_CHAIR, LOUNGE_FURNITURE, TABLE_CENTER, TABLE_RADIUS, stationPose, type WorkStationId,
} from "./layout";


export interface Effects {
  sparks(at: THREE.Vector3, color?: THREE.ColorRepresentation): void;
  puff(at: THREE.Vector3, color?: THREE.ColorRepresentation, rise?: number): void;
  wave(at: THREE.Vector3, color: THREE.ColorRepresentation): void;
}

export interface StationRig {
  id: StationId;
  group: THREE.Group;
  /** `active` counts crew currently working (or stuck) here; 0 means idle machinery.
   *  `occupied` lists arrived lounge spot indices (lounge only). */
  animate(dt: number, time: number, active: number, motion: boolean, effects: Effects, occupied?: ReadonlySet<number>): void;
}

const WHITE = "#e8ecf6";
const SHELL = "#d5dbeb";
const DARK = "#353c63";

function screen(width: number, height: number, color: string): THREE.Mesh {
  return mesh(new THREE.PlaneGeometry(width, height), uniqueMaterial("#0f1530", { emissive: color, emissiveIntensity: 0.35, roughness: 0.3 }), undefined, false);
}

function setGlow(target: THREE.Mesh, intensity: number) {
  (target.material as THREE.MeshStandardMaterial).emissiveIntensity = intensity;
}

function dishMaterial(): THREE.MeshStandardMaterial {
  const material = uniqueMaterial(WHITE, { roughness: 0.35 });
  material.side = THREE.DoubleSide;
  return material;
}

function place(station: WorkStationId, group: THREE.Group) {
  const { position, yaw } = stationPose(station);
  group.position.copy(position);
  group.rotation.y = yaw;
  group.scale.setScalar(1.18);
}

function worldPoint(group: THREE.Group, local: [number, number, number]): THREE.Vector3 {
  return group.localToWorld(new THREE.Vector3(...local));
}

function archive(): StationRig {
  const group = new THREE.Group();
  place("archive", group);
  const lights: THREE.Mesh[] = [];
  for (const x of [-0.62, 0.62]) {
    group.add(box(1.05, 1.75, 0.55, WHITE, [x, 0.875, -0.25], 0.1));
    group.add(box(0.95, 0.06, 0.5, SHELL, [x, 1.78, -0.22], 0.03));
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 3; column++) {
        const hue = ["#2dd4bf", "#5eead4", "#99f6e4", "#14b8a6"][(row + column) % 4];
        const cartridge = mesh(roundedBox(0.24, 0.26, 0.1, 0.03), uniqueMaterial(hue, { emissive: hue, emissiveIntensity: 0.15 }), [x - 0.3 + column * 0.3, 0.35 + row * 0.38, 0.06]);
        lights.push(cartridge);
        group.add(cartridge);
      }
    }
  }
  group.add(box(0.7, 0.75, 0.45, DARK, [0, 0.375, 0.42], 0.08));
  const reader = screen(0.5, 0.28, "#2dd4bf");
  reader.position.set(0, 0.78, 0.5);
  reader.rotation.x = -0.7;
  group.add(reader);
  let next = 0;
  return {
    id: "archive", group,
    animate(dt, time, active, motion) {
      setGlow(reader, active ? 0.9 + Math.sin(time * 6) * 0.2 : 0.3);
      if (!motion) return;
      next -= dt;
      if (next <= 0) {
        next = active ? 0.12 : 0.9;
        const pick = lights[Math.floor(Math.random() * lights.length)];
        setGlow(pick, active ? 1.4 : 0.5);
      }
      for (const light of lights) setGlow(light, Math.max(0.15, (light.material as THREE.MeshStandardMaterial).emissiveIntensity - dt * 2.2));
    },
  };
}

function scanner(): StationRig {
  const group = new THREE.Group();
  place("scanner", group);
  group.add(box(1.3, 0.8, 0.65, WHITE, [0, 0.4, 0.05], 0.1));
  group.add(cylinder(0.06, 0.08, 1.2, SHELL, [0, 1.2, -0.3]));
  const dish = markDynamic(new THREE.Group());
  dish.position.set(0, 1.85, -0.3);
  const bowl = mesh(new THREE.SphereGeometry(0.55, 28, 12, 0, Math.PI * 2, 0, Math.PI / 3.2), dishMaterial());
  bowl.rotation.x = Math.PI - 0.5;
  dish.add(bowl);
  dish.add(cylinder(0.025, 0.025, 0.5, SHELL, [0, -0.05, 0.12]));
  const tip = sphere(0.06, uniqueMaterial("#38bdf8", { emissive: "#38bdf8", emissiveIntensity: 1.2 }), [0, -0.3, 0.32]);
  dish.add(tip);
  group.add(dish);
  const radar = mesh(new THREE.CircleGeometry(0.26, 32), uniqueMaterial("#0b1d33", { emissive: "#0ea5e9", emissiveIntensity: 0.25 }), [0, 0.81, 0.1], false);
  radar.rotation.x = -Math.PI / 2;
  group.add(radar);
  const needle = markDynamic(mesh(new THREE.PlaneGeometry(0.03, 0.25), glow("#7dd3fc"), [0, 0.82, 0.1], false));
  needle.geometry.translate(0, 0.125, 0);
  needle.rotation.x = -Math.PI / 2;
  group.add(needle);
  return {
    id: "scanner", group,
    animate(dt, _time, active, motion) {
      if (motion) {
        dish.rotation.y += dt * (active ? 1.6 : 0.15);
        needle.rotation.z += dt * (active ? 4 : 0.4);
      }
      setGlow(radar, active ? 0.8 : 0.25);
    },
  };
}

function planning(): StationRig {
  const group = new THREE.Group();
  place("planning", group);
  group.add(cylinder(0.85, 0.7, 0.72, WHITE, [0, 0.36, 0], 36));
  group.add(mesh(new THREE.TorusGeometry(0.85, 0.05, 8, 40), plastic("#a78bfa"), [0, 0.72, 0]).rotateX(Math.PI / 2));
  const emitter = mesh(new THREE.CircleGeometry(0.5, 32), uniqueMaterial("#1e1640", { emissive: "#a78bfa", emissiveIntensity: 0.4 }), [0, 0.735, 0], false);
  emitter.rotation.x = -Math.PI / 2;
  group.add(emitter);
  const holo = markDynamic(new THREE.Group());
  holo.position.set(0, 1.35, 0);
  const wire = mesh(new THREE.IcosahedronGeometry(0.34, 0), new THREE.MeshBasicMaterial({ color: "#c4b5fd", wireframe: true, transparent: true, opacity: 0.85 }), undefined, false);
  const core = sphere(0.12, glow("#ddd6fe", 0.9), [0, 0, 0]);
  core.castShadow = false;
  holo.add(wire, core);
  const orbiters: THREE.Mesh[] = [];
  for (let index = 0; index < 3; index++) {
    const orbiter = mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), glow("#e9d5ff"), undefined, false);
    orbiters.push(orbiter);
    holo.add(orbiter);
  }
  group.add(holo);
  const beam = mesh(new THREE.CylinderGeometry(0.12, 0.45, 0.6, 24, 1, true), glow("#a78bfa", 0.16), [0, 1.03, 0], false);
  group.add(beam);
  return {
    id: "planning", group,
    animate(dt, time, active, motion) {
      const target = active ? 1 : 0.55;
      holo.scale.setScalar(THREE.MathUtils.lerp(holo.scale.x, target, 1 - Math.exp(-dt * 4)));
      (beam.material as THREE.MeshBasicMaterial).opacity = active ? 0.22 : 0.07;
      setGlow(emitter, active ? 1 : 0.35);
      if (!motion) return;
      wire.rotation.y += dt * (active ? 1.2 : 0.3);
      wire.rotation.x += dt * (active ? 0.7 : 0.15);
      holo.position.y = 1.35 + Math.sin(time * 1.6) * 0.05;
      orbiters.forEach((orbiter, index) => {
        const angle = time * (active ? 2.2 : 0.6) + (index * Math.PI * 2) / 3;
        orbiter.position.set(Math.cos(angle) * 0.55, Math.sin(angle * 2) * 0.12, Math.sin(angle) * 0.55);
        orbiter.rotation.y += dt * 3;
      });
    },
  };
}

function engineering(): StationRig {
  const group = new THREE.Group();
  place("engineering", group);
  group.add(box(1.8, 0.7, 0.85, "#c9cfe2", [0, 0.35, 0], 0.08));
  group.add(box(1.9, 0.1, 0.95, "#ff8a3d", [0, 0.74, 0], 0.04));
  group.add(box(1.8, 1.0, 0.1, SHELL, [0, 1.25, -0.42], 0.05));
  for (let index = 0; index < 4; index++) {
    group.add(box(0.06, 0.38, 0.04, ["#64748b", "#94a3b8", "#475569", "#94a3b8"][index], [-0.6 + index * 0.18, 1.32, -0.35], 0.02));
  }
  const workpiece = markDynamic(new THREE.Group());
  workpiece.position.set(0.15, 0.97, 0.05);
  workpiece.add(box(0.55, 0.36, 0.42, "#fb923c", [0, 0, 0], 0.07));
  workpiece.add(box(0.36, 0.04, 0.3, "#fed7aa", [0, 0.2, 0], 0.02));
  workpiece.add(cylinder(0.02, 0.02, 0.25, "#cbd5e1", [0.18, 0.3, -0.1], 8));
  const status = sphere(0.04, uniqueMaterial("#4ade80", { emissive: "#4ade80", emissiveIntensity: 0.6 }), [0.18, 0.44, -0.1], 10);
  workpiece.add(status);
  group.add(workpiece);
  const lampArm = cylinder(0.025, 0.025, 0.7, "#64748b", [-0.65, 1.12, -0.2], 8);
  lampArm.rotation.z = -0.5;
  group.add(lampArm);
  const bulb = sphere(0.09, uniqueMaterial("#fff7ed", { emissive: "#fed7aa", emissiveIntensity: 0.6 }), [-0.48, 1.42, -0.05], 14);
  group.add(bulb);
  let next = 0;
  return {
    id: "engineering", group,
    animate(dt, time, active, motion, effects) {
      setGlow(bulb, active ? 1.6 : 0.5);
      setGlow(status, active ? 0.6 + Math.max(0, Math.sin(time * 5)) : 0.4);
      if (!motion || !active) return;
      workpiece.rotation.y = Math.sin(time * 0.8) * 0.15;
      next -= dt;
      if (next <= 0) {
        next = 0.18 + Math.random() * 0.25;
        effects.sparks(worldPoint(group, [0.15 + (Math.random() - 0.5) * 0.3, 1.15, 0.25]));
      }
    },
  };
}

function fabricator(): StationRig {
  const group = new THREE.Group();
  place("fabricator", group);
  group.add(box(1.4, 1.55, 1.0, DARK, [0, 0.775, -0.1], 0.14));
  group.add(box(1.5, 0.14, 1.1, "#fbbf24", [0, 1.6, -0.1], 0.05));
  const window = mesh(roundedBox(0.95, 0.85, 0.05, 0.08), uniqueMaterial("#3b2a0a", { emissive: "#f59e0b", emissiveIntensity: 0.25, roughness: 0.2 }), [0, 0.85, 0.42], false);
  group.add(window);
  const gear = markDynamic(mesh(new THREE.TorusGeometry(0.22, 0.07, 6, 10), plastic("#cbd5e1", { metalness: 0.5, roughness: 0.3 }), [0.72, 1.15, 0.1]));
  gear.rotation.y = Math.PI / 2;
  group.add(gear);
  for (const x of [-0.4, 0.4]) group.add(cylinder(0.1, 0.12, 0.35, "#64748b", [x, 1.82, -0.25], 14));
  group.add(box(1.2, 0.3, 0.5, "#4b5563", [0, 0.15, 0.6], 0.06));
  let next = 0;
  return {
    id: "fabricator", group,
    animate(dt, time, active, motion, effects) {
      setGlow(window, active ? 0.9 + Math.sin(time * 9) * 0.35 : 0.2);
      if (!motion) return;
      gear.rotation.x += dt * (active ? 4 : 0.2);
      if (!active) return;
      next -= dt;
      if (next <= 0) {
        next = 0.35;
        effects.puff(worldPoint(group, [Math.random() > 0.5 ? 0.4 : -0.4, 2.05, -0.25]), "#e2e8f0", 0.9);
      }
    },
  };
}

function diagnostics(): StationRig {
  const group = new THREE.Group();
  place("diagnostics", group);
  group.add(box(1.7, 0.18, 1.0, "#c9cfe2", [0, 0.09, 0], 0.06));
  for (const x of [-0.7, 0.7]) group.add(box(0.12, 1.6, 0.12, SHELL, [x, 0.9, -0.2], 0.04));
  group.add(box(1.52, 0.12, 0.14, SHELL, [0, 1.68, -0.2], 0.04));
  const specimen = markDynamic(new THREE.Group());
  specimen.position.set(0, 0.95, -0.2);
  specimen.add(box(0.5, 0.4, 0.4, "#4ade80", [0, 0, 0], 0.08));
  specimen.add(cylinder(0.015, 0.015, 0.55, "#94a3b8", [0, 0.48, 0], 6));
  for (const x of [-0.35, 0.35]) {
    const probe = cylinder(0.02, 0.02, 0.4, "#f472b6", [x * 0.85, 0, 0], 6);
    probe.rotation.z = Math.PI / 2;
    specimen.add(probe);
  }
  group.add(specimen);
  group.add(box(0.5, 0.55, 0.1, DARK, [0.95, 0.85, 0.15], 0.05));
  group.add(cylinder(0.04, 0.06, 0.6, "#64748b", [0.95, 0.3, 0.15], 8));
  const leds: THREE.Mesh[] = [];
  for (let index = 0; index < 5; index++) {
    const led = sphere(0.035, uniqueMaterial("#4ade80", { emissive: "#4ade80", emissiveIntensity: 0.2 }), [0.95 - 0.16 + index * 0.08, 0.95, 0.21], 10);
    leds.push(led);
    group.add(led);
  }
  const trace = screen(0.38, 0.16, "#4ade80");
  trace.position.set(0.95, 0.76, 0.21);
  group.add(trace);
  return {
    id: "diagnostics", group,
    animate(_dt, time, active, motion) {
      setGlow(trace, active ? 0.7 + Math.sin(time * 12) * 0.25 : 0.2);
      leds.forEach((led, index) => {
        const lit = motion ? Math.floor(time * 6) % leds.length === index : index === 0;
        setGlow(led, active ? (lit ? 2 : 0.25) : 0.15);
      });
      if (motion && active) specimen.position.y = 0.95 + Math.sin(time * 18) * 0.008;
    },
  };
}

function comms(): StationRig {
  const group = new THREE.Group();
  place("comms", group);
  group.add(box(1.4, 0.75, 0.6, WHITE, [0, 0.375, 0.1], 0.1));
  const panel = screen(1.0, 0.3, "#f472b6");
  panel.position.set(0, 0.77, 0.2);
  panel.rotation.x = -Math.PI / 2 + 0.3;
  group.add(panel);
  group.add(cylinder(0.05, 0.07, 1.4, SHELL, [0.45, 1.1, -0.3], 10));
  const beacon = sphere(0.08, uniqueMaterial("#f472b6", { emissive: "#f472b6", emissiveIntensity: 1 }), [0.45, 1.85, -0.3], 12);
  group.add(beacon);
  const dish = markDynamic(new THREE.Group());
  dish.position.set(-0.35, 1.05, -0.25);
  const bowl = mesh(new THREE.SphereGeometry(0.45, 24, 10, 0, Math.PI * 2, 0, Math.PI / 3.4), dishMaterial());
  bowl.rotation.x = Math.PI + 0.6;
  dish.add(bowl);
  dish.add(cylinder(0.03, 0.05, 0.4, SHELL, [0, -0.2, 0], 8));
  group.add(dish);
  let next = 0;
  return {
    id: "comms", group,
    animate(dt, time, active, motion, effects) {
      setGlow(panel, active ? 0.9 : 0.25);
      setGlow(beacon, motion ? (Math.sin(time * (active ? 8 : 2)) > 0.3 ? 1.8 : 0.2) : 1);
      if (!motion) return;
      dish.rotation.y = Math.sin(time * (active ? 0.9 : 0.25)) * 0.7;
      if (!active) return;
      next -= dt;
      if (next <= 0) {
        next = 0.9;
        effects.wave(worldPoint(group, [-0.35, 1.45, -0.15]), "#f9a8d4");
      }
    },
  };
}

function lounge(): StationRig {
  const group = new THREE.Group();
  const { pingpong, arcade, chess, couch } = LOUNGE_FURNITURE;
  const place = (object: THREE.Object3D, at: THREE.Vector3, yaw: number) => {
    object.position.copy(at);
    object.rotation.y = yaw;
    group.add(object);
    return object;
  };

  // Ping-pong: long axis runs along the deck tangent so the players face each other.
  const table = new THREE.Group();
  place(table, pingpong, Math.PI / 2);
  table.add(box(0.95, 0.08, 1.8, "#1f8a5b", [0, 0.62, 0], 0.03));
  table.add(box(0.97, 0.02, 0.03, "#f8fafc", [0, 0.665, 0], 0.005));
  table.add(box(0.02, 0.012, 1.78, "#f8fafc", [0, 0.664, 0], 0.003));
  table.add(box(1.02, 0.14, 0.02, "#e2e8f0", [0, 0.73, 0], 0.005));
  for (const [x, z] of [[-0.38, -0.7], [0.38, -0.7], [-0.38, 0.7], [0.38, 0.7]]) table.add(cylinder(0.035, 0.035, 0.58, "#334155", [x, 0.29, z], 8));
  const ball = markDynamic(sphere(0.045, uniqueMaterial("#fff7ed", { emissive: "#fed7aa", emissiveIntensity: 0.4 }), [0, 0.8, 0], 10));
  table.add(ball);

  // Arcade cabinets against the hull.
  const screens: THREE.Mesh[] = [];
  arcade.forEach((spot, index) => {
    const cabinet = new THREE.Group();
    place(cabinet, spot, -Math.PI / 2);
    const color = index === 0 ? "#7c3aed" : "#0ea5e9";
    cabinet.add(box(0.62, 1.45, 0.55, color, [0, 0.725, 0], 0.08));
    cabinet.add(box(0.66, 0.2, 0.6, "#f472b6", [0, 1.5, 0.02], 0.06));
    cabinet.add(box(0.6, 0.1, 0.32, "#1e1b4b", [0, 0.95, 0.36], 0.03));
    cabinet.add(cylinder(0.025, 0.025, 0.12, "#e2e8f0", [-0.12, 1.05, 0.38], 8), sphere(0.045, "#ef4444", [-0.12, 1.12, 0.38], 10));
    for (const x of [0.06, 0.18]) cabinet.add(sphere(0.035, x > 0.1 ? "#facc15" : "#22c55e", [x, 1.02, 0.42], 8));
    const glass = mesh(new THREE.PlaneGeometry(0.46, 0.36), uniqueMaterial("#0b1023", { emissive: index === 0 ? "#22d3ee" : "#a3e635", emissiveIntensity: 0.25 }), [0, 1.26, 0.281], false);
    glass.rotation.x = -0.18;
    screens.push(glass);
    cabinet.add(glass);
  });

  // Chess table with two stools.
  const chessTable = new THREE.Group();
  place(chessTable, chess, Math.PI / 2);
  chessTable.add(cylinder(0.08, 0.16, 0.48, "#94a3b8", [0, 0.24, 0], 12));
  chessTable.add(cylinder(0.42, 0.42, 0.06, WHITE, [0, 0.5, 0], 28));
  const board = canvasTexture(64, (context, size) => {
    const cell = size / 4;
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
      context.fillStyle = (row + column) % 2 ? "#334155" : "#f1f5f9";
      context.fillRect(column * cell, row * cell, cell, cell);
    }
  });
  board.magFilter = THREE.NearestFilter;
  const boardMesh = mesh(new THREE.PlaneGeometry(0.46, 0.46), new THREE.MeshStandardMaterial({ map: board, roughness: 0.5 }), [0, 0.535, 0], false);
  boardMesh.rotation.x = -Math.PI / 2;
  chessTable.add(boardMesh);
  const pieces: THREE.Mesh[] = [];
  for (let index = 0; index < 6; index++) {
    const piece = cylinder(0.025, 0.035, 0.09, index < 3 ? "#f8fafc" : "#1e293b", [(index % 3 - 1) * 0.12, 0.58, index < 3 ? -0.17 : 0.17], 10);
    pieces.push(markDynamic(piece));
    chessTable.add(piece);
  }
  for (const side of [-1, 1]) {
    const stool = chess.clone().setX(chess.x + side * 0.62);
    group.add(cylinder(0.2, 0.2, 0.1, "#f97066", [stool.x, 0.4, stool.z], 18), cylinder(0.04, 0.08, 0.36, "#64748b", [stool.x, 0.18, stool.z], 8));
  }

  // Spectator couch facing the ping-pong game.
  const sofa = new THREE.Group();
  place(sofa, couch, Math.PI / 2);
  sofa.add(box(2.7, 0.38, 0.8, "#2bb3a3", [0, 0.24, 0], 0.14));
  sofa.add(box(2.7, 0.7, 0.26, "#2bb3a3", [0, 0.58, -0.38], 0.12));
  for (const x of [-1.4, 1.4]) sofa.add(box(0.24, 0.52, 0.8, "#2bb3a3", [x, 0.33, 0], 0.1));
  for (let seat = -1; seat <= 1; seat++) sofa.add(box(0.78, 0.08, 0.66, "#5fd0c4", [seat * 0.84, 0.45, 0.04], 0.04));
  sofa.add(cylinder(0.32, 0.32, 0.05, WHITE, [0, 0.36, 0.95], 24), cylinder(0.05, 0.1, 0.34, SHELL, [0, 0.17, 0.95], 10));
  const snack = markDynamic(cylinder(0.12, 0.08, 0.08, "#fbbf24", [0.08, 0.43, 0.95], 14));
  sofa.add(snack);

  for (const pot of [new THREE.Vector3(-9.9, 0, 0.55), new THREE.Vector3(-4.85, 0, 0.55), new THREE.Vector3(-9.85, 0, 4.3)]) {
    group.add(cylinder(0.22, 0.17, 0.36, "#f8fafc", [pot.x, 0.18, pot.z], 16));
    for (let leaf = 0; leaf < 6; leaf++) {
      const blade = mesh(new THREE.ConeGeometry(0.09, 0.6, 8), plastic(leaf % 2 ? "#4ade80" : "#22c55e"), [pot.x, 0.58, pot.z]);
      blade.rotation.set(Math.cos(leaf * 1.1) * 0.45, 0, Math.sin(leaf * 1.1) * 0.45);
      group.add(blade);
    }
  }

  let nextMove = 2;
  return {
    id: "lounge", group,
    animate(dt, time, _active, motion, _effects, occupied) {
      const rally = occupied?.has(0) && occupied.has(1);
      const solo = !rally && (occupied?.has(0) || occupied?.has(1));
      ball.visible = Boolean(rally || solo);
      if (ball.visible) {
        const period = 1.1;
        const u = motion ? (time % period) / period : 0.25;
        if (rally) {
          const forward = u < 0.5;
          const progress = forward ? u * 2 : (u - 0.5) * 2;
          ball.position.set(0, 0.68 + Math.sin(progress * Math.PI) * 0.35 + Math.abs(Math.sin(progress * Math.PI * 2)) * 0.02, (forward ? -0.85 + progress * 1.7 : 0.85 - progress * 1.7));
        } else {
          const side = occupied?.has(0) ? -1 : 1;
          ball.position.set(0, 0.68 + Math.abs(Math.sin(u * Math.PI * 2)) * 0.3, side * 0.6);
        }
      }
      screens.forEach((screen, index) => {
        const playing = occupied?.has(2 + index);
        setGlow(screen, playing ? 0.9 + (motion ? Math.sin(time * 17 + index * 2) * 0.35 : 0) : 0.2);
      });
      if (motion && occupied?.has(4) && occupied.has(5)) {
        nextMove -= dt;
        if (nextMove <= 0) {
          nextMove = 2.5 + Math.random() * 2;
          const piece = pieces[Math.floor(Math.random() * pieces.length)];
          piece.position.x = THREE.MathUtils.clamp(piece.position.x + (Math.random() > 0.5 ? 0.12 : -0.12), -0.18, 0.18);
          piece.position.z = THREE.MathUtils.clamp(piece.position.z + (piece.position.z > 0 ? -0.06 : 0.06), -0.18, 0.18);
        }
      }
      if (motion) snack.rotation.y = time * 0.3;
    },
  };
}

function bridge(): StationRig {
  const group = new THREE.Group();
  group.position.copy(TABLE_CENTER);
  group.add(cylinder(TABLE_RADIUS, TABLE_RADIUS - 0.18, 0.78, "#2c3360", [0, 0.39, 0], 48));
  group.add(mesh(new THREE.TorusGeometry(TABLE_RADIUS, 0.06, 10, 56), plastic("#fcd34d", { roughness: 0.35, metalness: 0.2 }), [0, 0.79, 0]).rotateX(Math.PI / 2));
  const top = mesh(new THREE.CircleGeometry(TABLE_RADIUS - 0.05, 48), uniqueMaterial("#121735", { emissive: "#38bdf8", emissiveIntensity: 0.18, roughness: 0.2 }), [0, 0.785, 0], false);
  top.rotation.x = -Math.PI / 2;
  group.add(top);

  const holo = markDynamic(new THREE.Group());
  holo.position.y = 1.55;
  const planetMaterial = uniqueMaterial("#60a5fa", { emissive: "#38bdf8", emissiveIntensity: 0.5, roughness: 0.4 });
  const planet = sphere(0.34, planetMaterial, [0, 0, 0], 28);
  planet.castShadow = false;
  const planetRing = mesh(new THREE.TorusGeometry(0.55, 0.02, 6, 48), glow("#bae6fd", 0.8), undefined, false);
  planetRing.rotation.x = Math.PI / 2 - 0.35;
  holo.add(planet, planetRing);
  group.add(holo);
  const beam = mesh(new THREE.CylinderGeometry(0.25, 0.8, 0.75, 32, 1, true), glow("#7dd3fc", 0.12), [0, 1.17, 0], false);
  group.add(beam);

  const reports: THREE.Mesh[] = [];
  for (let index = 0; index < 6; index++) {
    const report = mesh(new THREE.PlaneGeometry(0.34, 0.24), new THREE.MeshBasicMaterial({ color: "#fde68a", transparent: true, opacity: 0.85, side: THREE.DoubleSide }), undefined, false);
    report.visible = false;
    reports.push(report);
    holo.add(report);
  }

  const chair = new THREE.Group();
  chair.position.copy(CAPTAIN_CHAIR).sub(TABLE_CENTER);
  chair.add(cylinder(0.32, 0.38, 0.08, "#64748b", [0, 0.04, 0], 20));
  chair.add(cylinder(0.06, 0.06, 0.35, "#94a3b8", [0, 0.22, 0], 10));
  chair.add(box(0.75, 0.14, 0.7, "#e5484d", [0, 0.45, 0], 0.07));
  chair.add(box(0.75, 0.72, 0.16, "#e5484d", [0, 0.85, 0.3], 0.08));
  for (const x of [-0.42, 0.42]) chair.add(box(0.1, 0.12, 0.55, "#c2353a", [x, 0.62, 0.02], 0.04));
  chair.add(box(0.5, 0.06, 0.04, "#fcd34d", [0, 1.12, 0.39], 0.02));
  group.add(chair);

  return {
    id: "bridge", group,
    animate(dt, time, active, motion) {
      const alert = active > 0;
      planetMaterial.emissive.set(alert ? "#f59e0b" : "#38bdf8");
      planetMaterial.color.set(alert ? "#fbbf24" : "#60a5fa");
      (beam.material as THREE.MeshBasicMaterial).color.set(alert ? "#fcd34d" : "#7dd3fc");
      (beam.material as THREE.MeshBasicMaterial).opacity = alert ? 0.2 + (motion ? Math.sin(time * 4) * 0.06 : 0) : 0.1;
      (top.material as THREE.MeshStandardMaterial).emissive.set(alert ? "#f59e0b" : "#38bdf8");
      (top.material as THREE.MeshStandardMaterial).emissiveIntensity = alert ? 0.4 : 0.18;
      reports.forEach((report, index) => {
        report.visible = index < Math.min(active, reports.length);
        if (!report.visible) return;
        const angle = (motion ? time * 0.7 : 0) + (index * Math.PI * 2) / Math.min(active, reports.length);
        report.position.set(Math.cos(angle) * 0.85, 0.15 + (motion ? Math.sin(time * 2 + index) * 0.06 : 0), Math.sin(angle) * 0.85);
        report.rotation.set(-0.25, Math.atan2(Math.cos(angle), Math.sin(angle)), 0, "YXZ");
      });
      if (!motion) return;
      planet.rotation.y += dt * (alert ? 1.4 : 0.4);
      holo.position.y = 1.55 + Math.sin(time * 1.3) * 0.04;
    },
  };
}

export function buildStations(): StationRig[] {
  return [archive(), scanner(), planning(), engineering(), fabricator(), diagnostics(), comms(), lounge(), bridge()];
}
