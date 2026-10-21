import * as THREE from "three";
import { cylinder, mesh, plastic, sphere, uniqueMaterial } from "./kit";

/**
 * 3D takes on the VS Code chat pet's hat accessories. Every hat sits on the jelly's
 * head ring (local y = 0 is the hat base, head radius ≈ 0.2).
 */
type HatBuilder = (hat: THREE.Group) => void;

function dome(radius: number, color: string, y = 0): THREE.Mesh {
  return mesh(new THREE.SphereGeometry(radius, 22, 11, 0, Math.PI * 2, 0, Math.PI / 2), plastic(color, { roughness: 0.35 }), [0, y, 0]);
}

function disc(radius: number, height: number, color: string, y: number): THREE.Mesh {
  return cylinder(radius, radius, height, color, [0, y, 0], 28);
}

const HATS: Array<{ name: string; build: HatBuilder }> = [
  { name: "artist beret", build: (hat) => {
    const beret = sphere(0.28, "#b4232a", [0.04, 0.06, 0], 20);
    beret.scale.set(1, 0.34, 1);
    beret.rotation.z = -0.28;
    hat.add(beret, sphere(0.035, "#7f1d1d", [0.07, 0.15, 0], 8));
  } },
  { name: "bamboo hat", build: (hat) => {
    hat.add(cylinder(0.02, 0.54, 0.22, "#d8b36a", [0, 0.1, 0], 28), sphere(0.03, "#8a6a2f", [0, 0.22, 0], 8));
  } },
  { name: "baseball cap", build: (hat) => {
    hat.add(dome(0.23, "#2f6fe4"), sphere(0.03, "#ffffff", [0, 0.23, 0], 8));
    const brim = disc(0.19, 0.02, "#1f4fb0", 0.01);
    brim.scale.set(1, 1, 1.1);
    brim.position.z = 0.17;
    hat.add(brim);
  } },
  { name: "cowboy hat", build: (hat) => {
    hat.add(disc(0.44, 0.03, "#8b5a2b", 0.01));
    const rim = mesh(new THREE.TorusGeometry(0.43, 0.04, 8, 32), plastic("#8b5a2b"), [0, 0.04, 0]);
    rim.rotation.x = Math.PI / 2;
    rim.scale.set(1, 0.72, 1.4);
    hat.add(rim, cylinder(0.17, 0.21, 0.22, "#9a6531", [0, 0.13, 0], 20), disc(0.215, 0.05, "#3f2a14", 0.05));
    const dent = sphere(0.1, "#7a4c22", [0, 0.24, 0], 10);
    dent.scale.set(1.5, 0.3, 0.6);
    hat.add(dent);
  } },
  { name: "crown", build: (hat) => {
    const gold = uniqueMaterial("#f5c542", { metalness: 0.65, roughness: 0.25 });
    const band = mesh(new THREE.CylinderGeometry(0.21, 0.2, 0.12, 24, 1, true), gold, [0, 0.06, 0]);
    (band.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    hat.add(band);
    for (let index = 0; index < 5; index++) {
      const angle = (index / 5) * Math.PI * 2;
      hat.add(mesh(new THREE.ConeGeometry(0.045, 0.12, 8), gold, [Math.sin(angle) * 0.2, 0.17, Math.cos(angle) * 0.2]));
      hat.add(sphere(0.022, index % 2 ? "#3e63dd" : "#e5484d", [Math.sin(angle) * 0.21, 0.06, Math.cos(angle) * 0.21], 8));
    }
  } },
  { name: "sailor hat", build: (hat) => {
    hat.add(cylinder(0.21, 0.22, 0.1, "#f8fafc", [0, 0.05, 0], 22));
    const top = mesh(new THREE.TorusGeometry(0.2, 0.05, 8, 24), plastic("#f8fafc"), [0, 0.11, 0]);
    top.rotation.x = Math.PI / 2;
    hat.add(top, disc(0.2, 0.03, "#f1f5f9", 0.13), disc(0.222, 0.03, "#1e3a8a", 0.03));
  } },
  { name: "dark sailor hat", build: (hat) => {
    hat.add(cylinder(0.21, 0.22, 0.1, "#1e2a5a", [0, 0.05, 0], 22));
    const top = mesh(new THREE.TorusGeometry(0.2, 0.05, 8, 24), plastic("#1e2a5a"), [0, 0.11, 0]);
    top.rotation.x = Math.PI / 2;
    hat.add(top, disc(0.2, 0.03, "#25336b", 0.13), disc(0.222, 0.03, "#f8fafc", 0.03));
  } },
  { name: "straw hat", build: (hat) => {
    hat.add(disc(0.42, 0.025, "#e8c25f", 0.01), cylinder(0.17, 0.2, 0.17, "#efcf6f", [0, 0.1, 0], 20), disc(0.205, 0.05, "#d6333b", 0.05));
  } },
  { name: "chef hat", build: (hat) => {
    hat.add(cylinder(0.2, 0.21, 0.12, "#ffffff", [0, 0.06, 0], 22));
    for (let index = 0; index < 5; index++) {
      const angle = (index / 5) * Math.PI * 2;
      hat.add(sphere(0.12, "#f8fafc", [Math.sin(angle) * 0.13, 0.22, Math.cos(angle) * 0.13], 14));
    }
    hat.add(sphere(0.15, "#ffffff", [0, 0.28, 0], 16));
  } },
  { name: "wizard hat", build: (hat) => {
    hat.add(disc(0.34, 0.03, "#5b21b6", 0.01));
    const cone = mesh(new THREE.ConeGeometry(0.22, 0.62, 20), plastic("#6d28d9"), [0.03, 0.32, 0]);
    cone.rotation.z = -0.16;
    hat.add(cone);
    for (const [x, y, z] of [[0.11, 0.2, 0.15], [-0.08, 0.36, 0.12], [0.05, 0.5, 0.06]]) hat.add(sphere(0.026, uniqueMaterial("#fde68a", { emissive: "#fcd34d", emissiveIntensity: 0.8 }), [x, y, z], 8));
  } },
  { name: "grand top hat", build: (hat) => {
    hat.add(disc(0.3, 0.03, "#1f2937", 0.01), cylinder(0.17, 0.17, 0.4, "#111827", [0, 0.21, 0], 22), disc(0.172, 0.06, "#b91c1c", 0.06));
    // Monocle over the right eye (eye sits ~0.32 below the hat base).
    const monocle = mesh(new THREE.TorusGeometry(0.065, 0.012, 6, 20), uniqueMaterial("#f5c542", { metalness: 0.7, roughness: 0.2 }), [0.12, -0.32, 0.4]);
    hat.add(monocle, mesh(new THREE.CircleGeometry(0.058, 20), new THREE.MeshBasicMaterial({ color: "#dbeafe", transparent: true, opacity: 0.35 }), [0.12, -0.32, 0.401], false));
  } },
  { name: "party hat", build: (hat) => {
    const cone = mesh(new THREE.ConeGeometry(0.16, 0.42, 18), plastic("#ed83b5"), [0.05, 0.2, 0]);
    cone.rotation.z = -0.32;
    hat.add(cone, sphere(0.05, "#ffffff", [0.12, 0.42, 0], 10));
  } },
  { name: "firefighter helmet", build: (hat) => {
    hat.add(dome(0.24, "#d62828"));
    const brim = disc(0.3, 0.025, "#b91c1c", 0.01);
    brim.scale.set(0.9, 1, 1.25);
    brim.position.z = -0.06;
    hat.add(brim, mesh(new THREE.BoxGeometry(0.12, 0.12, 0.03), uniqueMaterial("#f5c542", { metalness: 0.6, roughness: 0.25 }), [0, 0.12, 0.22]));
    hat.add(mesh(new THREE.BoxGeometry(0.04, 0.12, 0.38), plastic("#991b1b"), [0, 0.2, 0]));
  } },
  { name: "propeller hat", build: (hat) => {
    ["#e5484d", "#3e63dd", "#ffc53d", "#30a46c"].forEach((color, index) => {
      hat.add(mesh(new THREE.SphereGeometry(0.21, 12, 8, (index * Math.PI) / 2, Math.PI / 2, 0, Math.PI / 2), plastic(color)));
    });
    hat.add(cylinder(0.015, 0.015, 0.14, "#64748b", [0, 0.27, 0], 6));
    const blade = new THREE.Group();
    blade.position.y = 0.34;
    for (const side of [-1, 1]) blade.add(mesh(new THREE.BoxGeometry(0.24, 0.012, 0.06), plastic("#e5484d"), [side * 0.12, 0, 0]));
    blade.userData.spin = true;
    blade.userData.dynamic = true;
    hat.add(blade);
  } },
];

/** Roughly a quarter of the crew goes bare-headed so the antennae stay part of the cast. */
const BARE_SLOTS = 5;

function hash(id: string, seed: number): number {
  let value = seed;
  for (let index = 0; index < id.length; index++) {
    value ^= id.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** A stable, random-looking signature hat per agent, or none. */
export function signatureHat(id: string): THREE.Group | undefined {
  const slot = hash(id, 0x9e3779b9) % (HATS.length + BARE_SLOTS);
  if (slot >= HATS.length) return undefined;
  const hat = new THREE.Group();
  hat.name = HATS[slot].name;
  HATS[slot].build(hat);
  return hat;
}

/** The pet's construction hard hat; signals risky work while on duty. */
export function hardHat(): THREE.Group {
  const hat = new THREE.Group();
  hat.add(dome(0.25, "#ffc53d"), disc(0.33, 0.03, "#f5b400", 0.01));
  hat.children[1].position.z = 0.05;
  hat.add(mesh(new THREE.BoxGeometry(0.045, 0.17, 0.38), plastic("#f5b400"), [0, 0.15, 0]));
  return hat;
}

export function spinHats(root: THREE.Object3D, amount: number): void {
  root.traverse((object) => { if (object.userData.spin) object.rotation.y += amount; });
}
