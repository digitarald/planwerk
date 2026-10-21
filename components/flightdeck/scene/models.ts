import * as THREE from "three";
import type { CrewMode, StationId } from "@/lib/flightdeck/crew";
import type { RiskLevel } from "@/lib/types";
import { box, capsule, cylinder, glow, hazardTexture, mesh, plastic, sphere, uniqueMaterial } from "./kit";
import { markDynamic, mergeStatic } from "./bake";
import { hardHat, signatureHat } from "./hats";
import type { Leisure } from "./layout";

/**
 * Crew are jelly gumdrops after the VS Code chat pet: a translucent drop with a glowing
 * core, pill eyes and two antennae. Body height is 1 in local units.
 */
const R = 0.5;
/** Local height of the hat base on the head. */
const HAT_BASE = 0.74;
/** Local height of the top of a hat-wearing head, for labels. */
export const BUDDY_HEIGHT = 1.12;

/**
 * Translucent jelly without transmission: transmission re-renders the whole scene every
 * frame. A fresnel rim brightens and firms up the silhouette instead, so the edge glows
 * and the core still shows through the clearer middle.
 */
function jellyMaterial(color: string): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color, roughness: 0.14, metalness: 0, transparent: true, opacity: 0.86,
    clearcoat: 1, clearcoatRoughness: 0.1, emissive: color, emissiveIntensity: 0.18,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", `
      float jellyRim = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.2);
      outgoingLight += diffuseColor.rgb * jellyRim * 0.7;
      diffuseColor.a = mix(diffuseColor.a, 1.0, jellyRim * 0.6);
      #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => "flightdeck-jelly";
  return material;
}

let bodyGeometry: THREE.BufferGeometry | undefined;
/** One shared body mesh for every buddy. */
function lathe(): THREE.BufferGeometry {
  if (!bodyGeometry) {
    bodyGeometry = new THREE.LatheGeometry(profile(), 36);
    bodyGeometry.userData.shared = true;
  }
  return bodyGeometry;
}

export function radiusAt(t: number): number {
  if (t < 0.1) return R * (0.82 + 0.18 * Math.sin((t / 0.1) * Math.PI / 2));
  const u = (t - 0.1) / 0.9;
  return R * Math.max(0, 1 - Math.pow(u, 1.55)) * (1 - 0.06 * u);
}

let bodyProfile: THREE.Vector2[] | undefined;
function profile(): THREE.Vector2[] {
  if (bodyProfile) return bodyProfile;
  const points = [new THREE.Vector2(0, 0)];
  for (let index = 0; index <= 40; index++) {
    const t = index / 40;
    points.push(new THREE.Vector2(Math.max(0.001, radiusAt(t)), t));
  }
  points.push(new THREE.Vector2(0, 1.005));
  bodyProfile = points;
  return points;
}

function surfaceZ(y: number, x: number): number {
  const r = radiusAt(y);
  return Math.sqrt(Math.max(0, r * r - x * x));
}

type PropName = "wrench" | "tablet" | "wand" | "clipboard" | "mug" | "report" | "headset" | "paddle" | "gear" | "bulb";

export interface BuddyRig {
  root: THREE.Group;
  /** Squash, hop and lean; everything that should deform with the body. */
  rig: THREE.Group;
  /** Floating tools follow the body but never squash. */
  tools: THREE.Group;
  bodyMaterial: THREE.MeshPhysicalMaterial;
  coreMaterial: THREE.MeshBasicMaterial;
  coreColor: THREE.Color;
  eyes: THREE.Group;
  faultEyes: THREE.Group;
  antennae: [THREE.Group, THREE.Group];
  tipMaterial: THREE.MeshStandardMaterial;
  props: Record<PropName, THREE.Object3D>;
  hat?: THREE.Group;
  hardHat: THREE.Group;
  beacon: THREE.Group;
  hazard: THREE.Mesh;
  halo: THREE.Mesh;
  /** Where helper bots launch from. */
  anchor: THREE.Object3D;
  /** Invisible pick target; rays never walk the detailed body. */
  hitProxy: THREE.Mesh;
}

function antenna(side: -1 | 1, material: THREE.Material, tipMaterial: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.position.set(side * 0.06, 0.8, -0.02);
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(side * 0.07, 0.2, -0.02),
    new THREE.Vector3(side * 0.24, 0.4, -0.04),
  ]);
  group.add(mesh(new THREE.TubeGeometry(curve, 12, 0.02, 6), material), sphere(0.055, tipMaterial, [side * 0.24, 0.4, -0.04], 12));
  return group;
}

export function buildBuddy(color: string, id: string): BuddyRig {
  const root = new THREE.Group();
  root.userData.crewId = id;
  const rig = new THREE.Group();
  const tools = new THREE.Group();
  root.add(rig, tools);

  const bodyMaterial = jellyMaterial(color);
  const body = mesh(lathe(), bodyMaterial);
  body.receiveShadow = false;
  rig.add(body);
  const coreColor = new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.55);
  const coreMaterial = new THREE.MeshBasicMaterial({ color: coreColor.clone() });
  rig.add(sphere(0.15, coreMaterial, [0, 0.27, -0.04], 16));
  const puddle = mesh(new THREE.CircleGeometry(0.58, 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false }), [0, 0.012, 0], false);
  puddle.rotation.x = -Math.PI / 2;
  root.add(puddle);

  const eyes = new THREE.Group();
  const faultEyes = new THREE.Group();
  eyes.position.y = faultEyes.position.y = 0.42;
  const eyeMaterial = plastic("#191a1b", { roughness: 0.15 });
  const shine = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  for (const side of [-1, 1]) {
    const x = side * 0.12;
    const z = surfaceZ(0.42, x) - 0.012;
    const eye = capsule(0.034, 0.07, eyeMaterial, [x, 0, z]);
    eye.scale.z = 0.6;
    eyes.add(eye, sphere(0.012, shine, [x + 0.012, 0.035, z + 0.02], 6));
    for (const tilt of [-1, 1]) {
      const stroke = box(0.1, 0.022, 0.02, eyeMaterial, [x, 0, z + 0.005], 0.008);
      stroke.rotation.z = tilt * Math.PI / 4;
      faultEyes.add(stroke);
    }
  }
  mergeStatic([eyes], eyes);
  mergeStatic([faultEyes], faultEyes);
  faultEyes.visible = false;
  rig.add(eyes, faultEyes);

  const stalk = uniqueMaterial(new THREE.Color(color).multiplyScalar(0.8), { roughness: 0.35 });
  const tipMaterial = uniqueMaterial(new THREE.Color(color).multiplyScalar(0.85), { emissive: color, emissiveIntensity: 0.1, roughness: 0.3 });
  const antennae: [THREE.Group, THREE.Group] = [antenna(-1, stalk, tipMaterial), antenna(1, stalk, tipMaterial)];
  rig.add(...antennae);

  const hat = signatureHat(id);
  if (hat) { mergeStatic([hat], hat); hat.position.y = HAT_BASE; rig.add(hat); }
  const helmet = hardHat();
  mergeStatic([helmet], helmet);
  helmet.position.y = HAT_BASE;
  helmet.visible = false;
  rig.add(helmet);
  const beacon = markDynamic(new THREE.Group());
  beacon.position.y = 0.3;
  beacon.add(cylinder(0.05, 0.06, 0.05, "#475569", [0, 0, 0], 10));
  beacon.add(sphere(0.06, uniqueMaterial("#ffb224", { emissive: "#ffb224", emissiveIntensity: 1.6 }), [0, 0.06, 0], 10));
  const beam = mesh(new THREE.ConeGeometry(0.12, 0.6, 12, 1, true), glow("#ffd27a", 0.26), [0.3, 0.06, 0], false);
  beam.rotation.z = Math.PI / 2;
  beacon.add(beam);
  beacon.visible = false;
  helmet.add(beacon);

  const hazard = mesh(new THREE.RingGeometry(0.66, 0.8, 40, 1), new THREE.MeshBasicMaterial({ map: hazardTexture(), transparent: true, opacity: 0.7 }), [0, 0.02, 0], false);
  hazard.rotation.x = -Math.PI / 2;
  hazard.visible = false;
  root.add(hazard);
  const halo = mesh(new THREE.RingGeometry(0.64, 0.72, 40), glow(color, 0.9), [0, 0.025, 0], false);
  halo.rotation.x = -Math.PI / 2;
  halo.visible = false;
  root.add(halo);

  const anchor = new THREE.Object3D();
  anchor.position.set(0, 0.75, -0.3);
  rig.add(anchor);

  const tool = (object: THREE.Object3D) => { object.visible = false; tools.add(object); return object; };
  const wrench = new THREE.Group();
  wrench.add(box(0.05, 0.28, 0.05, "#cbd5e1", [0, 0, 0], 0.015), box(0.13, 0.07, 0.05, "#cbd5e1", [0, 0.15, 0], 0.015));
  const tablet = new THREE.Group();
  tablet.add(box(0.32, 0.03, 0.22, "#1e293b", [0, 0, 0], 0.02));
  tablet.add(mesh(new THREE.PlaneGeometry(0.28, 0.18), glow("#5eead4"), [0, 0.018, 0], false).rotateX(-Math.PI / 2));
  const wand = new THREE.Group();
  wand.add(cylinder(0.022, 0.028, 0.32, "#e2e8f0", [0, 0, 0], 8).rotateX(Math.PI / 2), sphere(0.05, glow("#7dd3fc"), [0, 0, 0.18], 10));
  const clipboard = new THREE.Group();
  clipboard.add(box(0.22, 0.29, 0.025, "#fef3c7", [0, 0, 0], 0.015), box(0.09, 0.035, 0.035, "#64748b", [0, 0.14, 0.005], 0.01));
  const mug = new THREE.Group();
  mug.add(cylinder(0.065, 0.06, 0.12, "#fde68a", [0, 0, 0], 12));
  const steam = sphere(0.03, glow("#ffffff", 0.5), [0, 0.12, 0], 6);
  mug.add(steam);
  const report = new THREE.Group();
  report.add(box(0.36, 0.035, 0.26, "#1f2937", [0, 0, 0], 0.02));
  report.add(mesh(new THREE.PlaneGeometry(0.32, 0.22), glow("#fcd34d"), [0, 0.02, 0], false).rotateX(-Math.PI / 2));
  const headset = new THREE.Group();
  for (const side of [-1, 1]) headset.add(sphere(0.07, "#f472b6", [side * 0.4, 0.45, 0], 10));
  const mic = cylinder(0.012, 0.012, 0.22, "#334155", [0.3, 0.38, 0.22], 6);
  mic.rotation.set(0.9, 0, 0.7);
  headset.add(mic, sphere(0.03, "#334155", [0.2, 0.32, 0.32], 8));
  const paddle = new THREE.Group();
  paddle.add(cylinder(0.13, 0.13, 0.03, "#e5484d", [0, 0, 0], 18).rotateX(Math.PI / 2), box(0.04, 0.12, 0.04, "#78350f", [0, -0.15, 0], 0.01));
  const gear = new THREE.Group();
  gear.add(mesh(new THREE.TorusGeometry(0.11, 0.045, 6, 10), plastic("#cbd5e1", { metalness: 0.5, roughness: 0.3 })));
  const bulb = new THREE.Group();
  bulb.add(sphere(0.09, uniqueMaterial("#fef9c3", { emissive: "#fde047", emissiveIntensity: 1.2 }), [0, 0, 0], 14), cylinder(0.045, 0.045, 0.06, "#94a3b8", [0, -0.1, 0], 10));
  const props = {
    wrench: tool(wrench), tablet: tool(tablet), wand: tool(wand), clipboard: tool(clipboard), mug: tool(mug),
    report: tool(report), headset: tool(headset), paddle: tool(paddle), gear: tool(gear), bulb: tool(bulb),
  };

  const hitProxy = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.25, 10), new THREE.MeshBasicMaterial());
  hitProxy.position.y = 0.6;
  hitProxy.visible = false;
  hitProxy.userData.crewId = id;
  root.add(hitProxy);

  return { root, rig, tools, bodyMaterial, coreMaterial, coreColor, eyes, faultEyes, antennae, tipMaterial, props, hat, hardHat: helmet, beacon, hazard, halo, anchor, hitProxy };
}

/** The hard hat stands in for the signature hat while risky work is on duty. */
export function applyRisk(buddy: BuddyRig, risk: RiskLevel, onDuty: boolean): void {
  const risky = onDuty && risk !== "low";
  buddy.hardHat.visible = risky;
  buddy.beacon.visible = onDuty && risk === "high";
  buddy.hazard.visible = onDuty && risk === "high";
  if (buddy.hat) buddy.hat.visible = !risky;
  // Antennae tuck under any hat, like the VS Code pet's accessories.
  const hatted = risky || Boolean(buddy.hat);
  for (const stalk of buddy.antennae) stalk.visible = !hatted;
}

export interface PoseInput {
  mode: CrewMode;
  station: StationId;
  walking: boolean;
  seated: boolean;
  /** Per-agent time (offset so the crew don't move in lockstep). */
  time: number;
  /** Shared scene time, for games that need both players in sync. */
  clock: number;
  leisure?: Leisure;
  /** Walking speed relative to a stroll; long trips become a bouncy jog. */
  pace?: number;
  motion: boolean;
}

function squash(rig: THREE.Group, amount: number) {
  const side = 1 / Math.sqrt(amount);
  rig.scale.set(side, amount, side);
}

const SEAT = 0.31;
const PINGPONG_PERIOD = 1.1;
const FAULT_CORE = new THREE.Color("#ff6b6b");

export function poseBuddy(buddy: BuddyRig, input: PoseInput): void {
  const { rig, props, antennae } = buddy;
  const t = input.motion ? input.time : 0;
  rig.position.set(0, 0, 0);
  rig.rotation.set(0, 0, 0);
  squash(rig, 1 + (input.motion ? Math.sin(t * 2.2) * 0.02 : 0));
  for (const prop of Object.values(props)) prop.visible = false;
  buddy.eyes.position.x = 0;
  buddy.eyes.scale.y = input.motion && t % 4.3 < 0.12 ? 0.15 : 1;
  buddy.eyes.visible = input.mode !== "fault";
  buddy.faultEyes.visible = input.mode === "fault";
  antennae[0].rotation.set(0, 0, Math.sin(t * 1.7) * 0.08);
  antennae[1].rotation.set(0, 0, -Math.sin(t * 1.7 + 1) * 0.08);
  buddy.tipMaterial.emissiveIntensity = 0.1;
  buddy.coreMaterial.color.copy(buddy.coreColor);
  buddy.beacon.rotation.y = t * 5;
  buddy.hazard.rotation.z = t * 0.6;

  const place = (name: PropName, x: number, y: number, z: number) => {
    const prop = props[name];
    prop.visible = true;
    prop.position.set(x, y, z);
    prop.rotation.set(0, 0, 0);
    return prop;
  };

  if (input.walking) {
    const pace = input.pace ?? 1;
    const cadence = 9 * Math.pow(pace, 0.55);
    const hop = Math.abs(Math.sin(t * cadence));
    rig.position.y = hop * (0.16 + (pace - 1) * 0.05);
    squash(rig, 0.9 + hop * 0.18);
    rig.rotation.x = 0.1 + (pace - 1) * 0.05;
    antennae[0].rotation.x = antennae[1].rotation.x = -0.3 * hop;
    if (input.mode === "reporting") place("report", 0, 1.25, 0.15).rotation.x = -0.5;
    syncTools(buddy);
    return;
  }

  if (input.mode === "resting") {
    poseLeisure(buddy, input, place);
    syncTools(buddy);
    return;
  }

  if (input.mode === "reporting") {
    const report = place("report", 0, 1.3 + Math.sin(t * 3) * 0.04, 0.2);
    report.rotation.x = -0.6;
    const cycle = t % 3.2;
    const jump = cycle < 0.4 ? Math.sin((cycle / 0.4) * Math.PI) : 0;
    rig.position.y = jump * 0.22;
    squash(rig, cycle < 0.4 ? 0.9 + jump * 0.2 : 1);
    antennae[0].rotation.z = 0.25;
    antennae[1].rotation.z = -0.25;
    buddy.tipMaterial.emissiveIntensity = 0.6 + Math.sin(t * 6) * 0.4;
    syncTools(buddy);
    return;
  }

  if (input.mode === "fault") {
    const cycle = t % 2.6;
    rig.rotation.z = cycle < 0.7 ? Math.sin(t * 28) * 0.1 : Math.sin(t * 2) * 0.04;
    squash(rig, cycle < 0.7 ? 1 + Math.sin(t * 28) * 0.05 : 0.94);
    buddy.coreMaterial.color.copy(buddy.coreColor).lerp(FAULT_CORE, 0.5 + Math.sin(t * 6) * 0.4);
    syncTools(buddy);
    return;
  }

  switch (input.station) {
    case "engineering": {
      const beat = Math.sin(t * 9);
      place("wrench", 0.46, 0.55, 0.32).rotation.z = -0.4 + beat * 0.8;
      squash(rig, 1 - Math.max(0, beat) * 0.06);
      rig.rotation.x = 0.08;
      break;
    }
    case "archive":
      place("tablet", 0, 0.62, 0.5).rotation.x = -0.9;
      rig.rotation.x = 0.12 + Math.sin(t * 1.2) * 0.04;
      buddy.eyes.position.x = Math.sin(t * 2.4) * 0.03;
      break;
    case "scanner": {
      const wand = place("wand", 0.38, 0.55, 0.36);
      wand.rotation.y = Math.sin(t * 1.6) * 0.7;
      rig.rotation.y = Math.sin(t * 1.3) * 0.4;
      break;
    }
    case "planning":
      place("bulb", 0, 1.32 + Math.sin(t * 2) * 0.05, 0).scale.setScalar(0.9 + Math.sin(t * 4) * 0.1);
      rig.rotation.z = Math.sin(t * 1.2) * 0.06;
      antennae[0].rotation.z = Math.sin(t * 4) * 0.25;
      antennae[1].rotation.z = -Math.sin(t * 4 + 1) * 0.25;
      break;
    case "fabricator":
      place("gear", 0.44, 0.62, 0.28).rotation.set(0, 0, t * 6);
      squash(rig, 1 + Math.sin(t * 18) * 0.03);
      break;
    case "diagnostics":
      place("clipboard", -0.4, 0.55, 0.34).rotation.y = 0.4;
      rig.rotation.x = Math.sin(t * 3) * 0.08;
      break;
    case "comms":
      place("headset", 0, 0, 0);
      rig.position.y = Math.abs(Math.sin(t * 4)) * 0.03;
      buddy.tipMaterial.emissiveIntensity = 0.5 + Math.sin(t * 8) * 0.4;
      break;
    default:
      squash(rig, 1 + Math.sin(t * 5) * 0.04);
  }
  syncTools(buddy);
}

/** Tools ride along with hops and seats but keep their own shape. */
function syncTools(buddy: BuddyRig) {
  buddy.tools.position.copy(buddy.rig.position);
  buddy.tools.rotation.y = buddy.rig.rotation.y;
}

function poseLeisure(buddy: BuddyRig, input: PoseInput, place: (name: PropName, x: number, y: number, z: number) => THREE.Object3D): void {
  const { rig } = buddy;
  const t = input.motion ? input.time : 0;
  if (input.seated) rig.position.y = SEAT;
  switch (input.leisure) {
    case "pingpong-a":
    case "pingpong-b": {
      const u = input.motion ? (input.clock % PINGPONG_PERIOD) / PINGPONG_PERIOD : 0;
      const hitAt = input.leisure === "pingpong-a" ? 0 : 0.5;
      const swing = Math.cos((u - hitAt) * Math.PI * 2);
      const paddle = place("paddle", 0.45, 0.6, 0.25 + swing * 0.12);
      paddle.rotation.y = -swing * 0.8;
      rig.rotation.y = swing * 0.2;
      rig.position.y = Math.max(0, swing) * 0.06;
      squash(rig, 1 + swing * 0.05);
      return;
    }
    case "arcade": {
      squash(rig, 1 + Math.sin(t * 20) * 0.035);
      buddy.coreMaterial.color.copy(buddy.coreColor).offsetHSL(Math.sin(t * 3) * 0.08, 0, 0);
      const cycle = t % 7;
      if (cycle < 0.5) {
        const jump = Math.sin((cycle / 0.5) * Math.PI);
        rig.position.y = jump * 0.3;
        squash(rig, 0.9 + jump * 0.2);
      }
      return;
    }
    case "chess": {
      squash(rig, 0.92);
      const cycle = t % 5;
      rig.rotation.x = cycle < 0.8 ? Math.sin((cycle / 0.8) * Math.PI) * 0.18 : 0;
      buddy.antennae[0].rotation.z = Math.sin(t * 0.8) * 0.2;
      return;
    }
    default: {
      squash(rig, input.seated ? 0.82 + Math.sin(t * 1.4) * 0.02 : 0.95);
      const mug = place("mug", 0.42, 0.55 + Math.sin(t * 0.7) * 0.05, 0.22);
      mug.rotation.z = Math.sin(t * 0.7) * 0.15;
      buddy.eyes.scale.y = 0.55;
    }
  }
}

// ── Helpers: Copilot-style bots, one per active subagent ──

export interface Robot {
  root: THREE.Group;
  /** Thruster flame; flickers while hovering. */
  thrust: THREE.Mesh;
  /** 0→1 while popping out, 1→0 while docking. */
  presence: number;
  leaving: boolean;
  seed: number;
}

export function buildRobot(color: string): Robot {
  const root = new THREE.Group();
  const shell = uniqueMaterial("#f2f4fb", { roughness: 0.32, metalness: 0.1 });
  const head = mesh(new THREE.SphereGeometry(0.17, 22, 16), shell);
  head.scale.set(1.15, 0.92, 1);
  root.add(head);
  // Goggle visor with two glowing oval eyes.
  const visor = mesh(new THREE.CapsuleGeometry(0.075, 0.13, 6, 16), plastic("#1b1f35", { roughness: 0.2 }), [0, 0.0, 0.11]);
  visor.rotation.z = Math.PI / 2;
  visor.scale.set(1, 1, 0.55);
  root.add(visor);
  const eyeGlow = glow("#8be9ff");
  const cupMaterial = uniqueMaterial(color, { roughness: 0.35 });
  for (const side of [-1, 1]) {
    const eye = mesh(new THREE.CapsuleGeometry(0.026, 0.035, 4, 10), eyeGlow, [side * 0.055, 0.005, 0.155], false);
    eye.scale.z = 0.4;
    root.add(eye);
  }
  // Ear cups in the parent's color tie the helper to its agent.
  for (const side of [-1, 1]) {
    const cup = cylinder(0.065, 0.065, 0.06, cupMaterial, [side * 0.2, 0, 0], 16);
    cup.rotation.z = Math.PI / 2;
    root.add(cup);
  }
  const brow = mesh(new THREE.TorusGeometry(0.15, 0.018, 6, 20, Math.PI), plastic("#d7dcec"), [0, 0.04, 0.02]);
  brow.rotation.set(-0.2, 0, 0);
  root.add(brow);
  const thrust = markDynamic(mesh(new THREE.ConeGeometry(0.05, 0.16, 10, 1, true), glow("#7dd3fc", 0.6), [0, -0.21, 0], false));
  thrust.rotation.x = Math.PI;
  root.add(thrust);
  mergeStatic([root], root);
  root.scale.setScalar(0.001);
  return { root, thrust, presence: 0, leaving: false, seed: Math.random() * 10 };
}
