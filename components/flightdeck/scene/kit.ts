import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

const materials = new Map<string, THREE.MeshStandardMaterial>();

interface MaterialOptions {
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  transparent?: boolean;
  opacity?: number;
}

/** Shared toy-plastic material. Never mutate; use `uniqueMaterial` for animated surfaces. */
export function plastic(color: THREE.ColorRepresentation, options: MaterialOptions = {}): THREE.MeshStandardMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${options.emissive ? new THREE.Color(options.emissive).getHexString() : ""}|${options.emissiveIntensity ?? 0}|${options.roughness ?? 0.55}|${options.metalness ?? 0.05}`;
  let material = materials.get(key);
  if (!material) {
    material = uniqueMaterial(color, options);
    material.userData.shared = true;
    materials.set(key, material);
  }
  return material;
}

export function uniqueMaterial(color: THREE.ColorRepresentation, options: MaterialOptions = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.55,
    metalness: options.metalness ?? 0.05,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
  });
}

export function glow(color: THREE.ColorRepresentation, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
}

export function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, position?: [number, number, number], shadows = true): THREE.Mesh {
  const result = new THREE.Mesh(geometry, material);
  if (position) result.position.set(...position);
  result.castShadow = shadows;
  result.receiveShadow = shadows;
  return result;
}

export function roundedBox(width: number, height: number, depth: number, radius = 0.08): THREE.BufferGeometry {
  return new RoundedBoxGeometry(width, height, depth, 2, Math.min(radius, width / 2, height / 2, depth / 2) * 0.999);
}

type Paint = THREE.ColorRepresentation | THREE.Material;
const paint = (value: Paint) => (value instanceof THREE.Material ? value : plastic(value));

export function box(width: number, height: number, depth: number, color: Paint, position: [number, number, number], radius = 0.08): THREE.Mesh {
  return mesh(roundedBox(width, height, depth, radius), paint(color), position);
}

export function cylinder(radiusTop: number, radiusBottom: number, height: number, color: Paint, position: [number, number, number], segments = 24): THREE.Mesh {
  return mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), paint(color), position);
}

export function sphere(radius: number, color: Paint, position: [number, number, number], segments = 20): THREE.Mesh {
  return mesh(new THREE.SphereGeometry(radius, segments, Math.max(8, Math.round(segments * 0.66))), paint(color), position);
}

export function capsule(radius: number, length: number, color: Paint, position: [number, number, number]): THREE.Mesh {
  return mesh(new THREE.CapsuleGeometry(radius, length, 6, 16), paint(color), position);
}

export function canvasTexture(size: number, draw: (context: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  draw(canvas.getContext("2d")!, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function hazardTexture(): THREE.CanvasTexture {
  const texture = canvasTexture(128, (context, size) => {
    context.fillStyle = "#1d1a10";
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#ffb224";
    for (let x = -size; x < size * 2; x += 32) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + 16, 0);
      context.lineTo(x + 16 + size, size);
      context.lineTo(x + size, size);
      context.fill();
    }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

export function easeOutBack(value: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(value - 1, 3) + c1 * Math.pow(value - 1, 2);
}

export function damp(current: number, target: number, rate: number, dt: number): number {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * (1 - Math.exp(-rate * dt));
}

/** Dispose geometry and non-shared materials below `root`. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const candidate = object as Partial<THREE.Mesh>;
    if (!candidate.geometry?.userData.shared) candidate.geometry?.dispose();
    const material = candidate.material;
    for (const item of Array.isArray(material) ? material : material ? [material] : []) {
      if (item.userData.shared) continue;
      for (const value of Object.values(item)) if (value instanceof THREE.Texture) value.dispose();
      item.dispose();
    }
  });
}

export function disposeSharedMaterials(): void {
  for (const material of materials.values()) material.dispose();
  materials.clear();
}
