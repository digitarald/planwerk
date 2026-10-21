import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Objects that move, scale or toggle visibility opt out of merging. */
export function markDynamic<T extends THREE.Object3D>(object: T): T {
  object.userData.dynamic = true;
  return object;
}

/** Below this radius a mesh is too small for its shadow to read at the flightdeck camera. */
const SHADOW_MIN_RADIUS = 0.09;

function isDynamic(object: THREE.Object3D, stop: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node && node !== stop; node = node.parent) {
    if (node.userData.dynamic || !node.visible) return true;
  }
  return false;
}

/** A private copy with only position/normal/uv and an index, safe to transform in place. */
function normalize(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.clone();
  const result = new THREE.BufferGeometry();
  const position = geometry.attributes.position;
  result.setAttribute("position", position);
  result.setAttribute("normal", geometry.attributes.normal ?? new THREE.Float32BufferAttribute(new Float32Array(position.count * 3), 3));
  result.setAttribute("uv", geometry.attributes.uv ?? new THREE.Float32BufferAttribute(new Float32Array(position.count * 2), 2));
  result.setIndex(geometry.index ?? Array.from({ length: position.count }, (_, index) => index));
  if (!geometry.attributes.normal) result.computeVertexNormals();
  return result;
}

/**
 * Merge static meshes under `roots` that share a material into one mesh each, expressed in
 * `space`'s local coordinates and added to it. Tiny parts stop casting shadows.
 */
export function mergeStatic(roots: THREE.Object3D[], space: THREE.Object3D): void {
  space.updateMatrixWorld(true);
  const toSpace = new THREE.Matrix4().copy(space.matrixWorld).invert();
  const groups = new Map<string, { material: THREE.Material; castShadow: boolean; receiveShadow: boolean; meshes: THREE.Mesh[] }>();
  const sphere = new THREE.Sphere();
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh || Array.isArray(mesh.material)) return;
      if (isDynamic(mesh, root.parent ?? root)) return;
      mesh.geometry.computeBoundingSphere();
      sphere.copy(mesh.geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld);
      const castShadow = mesh.castShadow && sphere.radius >= SHADOW_MIN_RADIUS;
      const key = `${mesh.material.uuid}|${castShadow}|${mesh.receiveShadow}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { material: mesh.material, castShadow, receiveShadow: mesh.receiveShadow, meshes: [] }));
      group.meshes.push(mesh);
    });
  }
  for (const group of groups.values()) {
    if (group.meshes.length === 1) {
      group.meshes[0].castShadow = group.castShadow;
      continue;
    }
    const parts = group.meshes.map((mesh) => {
      const geometry = normalize(mesh.geometry).applyMatrix4(new THREE.Matrix4().multiplyMatrices(toSpace, mesh.matrixWorld));
      return geometry;
    });
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) continue;
    const combined = new THREE.Mesh(merged, group.material);
    combined.castShadow = group.castShadow;
    combined.receiveShadow = group.receiveShadow;
    combined.matrixAutoUpdate = false;
    space.add(combined);
    // Baking runs before the first frame, so the originals never reached the GPU.
    for (const mesh of group.meshes) mesh.removeFromParent();
  }
}
