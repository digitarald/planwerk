import * as THREE from "three";
import { markDynamic } from "./bake";
import { box, canvasTexture, cylinder, glow, mesh, plastic, sphere, uniqueMaterial } from "./kit";
import { AIRLOCK } from "./layout";

const HALF_W = 10.6;
const HALF_D = 6.25;
const CORNER = 2.3;

/** Hull outline in shape space (shape y = world -z); `grow` offsets it outward. */
export function hullShape(grow: number): THREE.Shape {
  const w = HALF_W + grow;
  const d = HALF_D + grow;
  const r = CORNER + grow;
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -d);
  shape.lineTo(w - r, -d);
  shape.quadraticCurveTo(w, -d, w, -d + r);
  shape.lineTo(w, d - r);
  shape.quadraticCurveTo(w, d, w - r, d);
  shape.lineTo(4.6 + grow * 0.6, d);
  shape.quadraticCurveTo(0, d + 3.1 + grow, -4.6 - grow * 0.6, d);
  shape.lineTo(-w + r, d);
  shape.quadraticCurveTo(-w, d, -w, d - r);
  shape.lineTo(-w, -d + r);
  shape.quadraticCurveTo(-w, -d, -w + r, -d);
  return shape;
}

function slab(shape: THREE.Shape, depth: number, material: THREE.Material, y: number, bevel = 0.06): THREE.Mesh {
  const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 32 });
  geometry.rotateX(-Math.PI / 2);
  const result = mesh(geometry, material);
  result.position.y = y;
  return result;
}

function ring(outerGrow: number, innerGrow: number): THREE.Shape {
  const shape = hullShape(outerGrow);
  shape.holes.push(new THREE.Path(hullShape(innerGrow).getPoints(96)));
  return shape;
}

function floorTexture(): THREE.CanvasTexture {
  const texture = canvasTexture(256, (context, size) => {
    const tile = size / 2;
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 2; column++) {
        context.fillStyle = (row + column) % 2 === 0 ? "#3d4573" : "#3a426f";
        context.fillRect(column * tile, row * tile, tile, tile);
        context.fillStyle = "rgba(255,255,255,0.05)";
        context.fillRect(column * tile + 10, row * tile + 10, tile - 20, 6);
      }
    }
    context.strokeStyle = "#2f365c";
    context.lineWidth = 6;
    for (let index = 0; index <= 2; index++) {
      context.beginPath(); context.moveTo(index * tile, 0); context.lineTo(index * tile, size); context.stroke();
      context.beginPath(); context.moveTo(0, index * tile); context.lineTo(size, index * tile); context.stroke();
    }
    context.fillStyle = "#30375e";
    for (const [x, y] of [[tile, tile], [0, 0], [tile, 0], [0, tile]]) {
      context.beginPath(); context.arc(x + 14, y + 14, 3.5, 0, Math.PI * 2); context.fill();
    }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(0.5, 0.5);
  return texture;
}

function exhaust(color: string, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false });
}

export interface Hull {
  root: THREE.Group;
  update(dt: number, time: number, motion: boolean): void;
}

export function buildHull(): Hull {
  const root = new THREE.Group();

  const floorMaterial = new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.82, metalness: 0.05 });
  root.add(slab(hullShape(0), 0.4, floorMaterial, -0.46, 0.04));
  root.add(slab(hullShape(0.8), 0.55, plastic("#262b4d", { roughness: 0.7 }), -1.25, 0.12));
  root.add(slab(ring(0.85, 0.55), 0.14, plastic("#ff8a3d", { roughness: 0.4 }), -0.82, 0.03));
  root.add(slab(ring(0.55, 0), 0.62, plastic("#eef1f8", { roughness: 0.42 }), -0.42, 0.08));
  root.add(slab(ring(0.48, 0.08), 0.06, plastic("#c9d0e6"), 0.24, 0.02));

  // Rim running lights chase around the hull: one instanced draw for all of them.
  const rimPoints = hullShape(0.28).getSpacedPoints(54).slice(0, -1);
  const rimLights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: "#ffffff" }), rimPoints.length);
  const rimMatrix = new THREE.Matrix4();
  rimPoints.forEach((point, index) => rimLights.setMatrixAt(index, rimMatrix.makeTranslation(point.x, 0.3, -point.y)));
  root.add(rimLights);
  const rimDim = new THREE.Color("#3fa9c4");
  const rimBright = new THREE.Color("#eafdff");
  const rimColor = new THREE.Color();

  // Forward viewport with drifting stars below the glass.
  const starsTexture = canvasTexture(256, (context, size) => {
    context.fillStyle = "#0a0f2e";
    context.fillRect(0, 0, size, size);
    for (let index = 0; index < 70; index++) {
      context.fillStyle = `rgba(${200 + Math.random() * 55},${210 + Math.random() * 45},255,${0.35 + Math.random() * 0.65})`;
      context.beginPath(); context.arc(Math.random() * size, Math.random() * size, Math.random() * 1.6 + 0.4, 0, Math.PI * 2); context.fill();
    }
  });
  starsTexture.wrapS = starsTexture.wrapT = THREE.RepeatWrapping;
  starsTexture.repeat.set(2, 1);
  const viewportShape = new THREE.Shape();
  viewportShape.moveTo(-3.4, 0);
  viewportShape.quadraticCurveTo(0, 4, 3.4, 0);
  viewportShape.lineTo(-3.4, 0);
  const viewportGeometry = new THREE.ShapeGeometry(viewportShape, 32);
  viewportGeometry.rotateX(-Math.PI / 2);
  const viewport = mesh(viewportGeometry, new THREE.MeshStandardMaterial({ map: starsTexture, roughness: 0.15, metalness: 0.3, emissive: "#ffffff", emissiveMap: starsTexture, emissiveIntensity: 0.9 }), [0, 0.012, -5.55], false);
  viewport.receiveShadow = true;
  root.add(viewport);
  const viewportFrameGeometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(new THREE.Shape().moveTo(-3.4, 0).quadraticCurveTo(0, 4, 3.4, 0).getPoints(24).map((point) => new THREE.Vector3(point.x, 0.04, -point.y))), 48, 0.07, 8, false);
  root.add(mesh(viewportFrameGeometry, plastic("#9aa6d6", { metalness: 0.4, roughness: 0.3 }), [0, 0, -5.55]));

  // Airlock pad where crew arrive and leave.
  const airlockTexture = canvasTexture(128, (context, size) => {
    context.fillStyle = "#30365c"; context.fillRect(0, 0, size, size);
    context.strokeStyle = "#ffb224"; context.lineWidth = 10;
    for (let x = -size; x < size * 2; x += 28) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x + size, size); context.stroke(); }
    context.fillStyle = "#30365c"; context.fillRect(16, 16, size - 32, size - 32);
    context.fillStyle = "#3d4573"; context.fillRect(22, 22, size - 44, size - 44);
  });
  const airlock = mesh(new THREE.PlaneGeometry(1.7, 1.1), new THREE.MeshStandardMaterial({ map: airlockTexture, roughness: 0.7 }), [AIRLOCK.x, 0.012, AIRLOCK.z + 0.45], false);
  airlock.rotation.x = -Math.PI / 2;
  airlock.receiveShadow = true;
  root.add(airlock);
  const airlockLight = sphere(0.09, uniqueMaterial("#ffb224", { emissive: "#ffb224", emissiveIntensity: 1 }), [0, 0.42, AIRLOCK.z + 1.05]);
  root.add(airlockLight);

  // Engines out back.
  const flames: THREE.Mesh[] = [];
  for (const x of [-5.6, -2.1, 2.1, 5.6]) {
    const nacelle = cylinder(0.46, 0.58, 1.0, "#d9deec", [x, -0.6, 6.7], 28);
    nacelle.rotation.x = Math.PI / 2;
    root.add(nacelle);
    const rim = mesh(new THREE.TorusGeometry(0.52, 0.08, 10, 28), plastic("#ff8a3d"), [x, -0.6, 7.22]);
    root.add(rim);
    const core = mesh(new THREE.CircleGeometry(0.42, 28), glow("#9ae6ff"), [x, -0.6, 7.26], false);
    root.add(core);
    const flame = markDynamic(mesh(new THREE.ConeGeometry(0.38, 1.3, 20, 1, true), exhaust("#3b82f6", 0.45), [x, -0.6, 7.9], false));
    flame.rotation.x = Math.PI / 2;
    flames.push(flame);
    root.add(flame);
    const inner = mesh(new THREE.ConeGeometry(0.2, 0.8, 16, 1, true), exhaust("#a5f3fc", 0.6), [0, 0.25, 0], false);
    flame.add(inner);
  }

  // Starfield streaming past below the ship.
  const starCount = 900;
  const positions = new Float32Array(starCount * 3);
  for (let index = 0; index < starCount; index++) {
    positions[index * 3] = (Math.random() - 0.5) * 120;
    positions[index * 3 + 1] = -6 - Math.random() * 40;
    positions[index * 3 + 2] = (Math.random() - 0.5) * 90;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: "#dfe8ff", size: 0.16, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false }));
  root.add(stars);

  const exterior = buildExterior();
  root.add(exterior.root);

  return {
    root,
    update(dt, time, motion) {
      exterior.update(time, motion);
      for (let index = 0; index < rimPoints.length; index++) {
        const wave = (Math.sin(time * 2.4 - index * 0.55) + 1) / 2;
        rimLights.setColorAt(index, rimColor.lerpColors(rimDim, rimBright, motion ? wave * wave : 0.4));
      }
      rimLights.instanceColor!.needsUpdate = true;
      (airlockLight.material as THREE.MeshStandardMaterial).emissiveIntensity = motion ? 0.6 + Math.max(0, Math.sin(time * 3)) * 1.4 : 1;
      flames.forEach((flame, index) => {
        const flicker = motion ? 1 + Math.sin(time * 23 + index * 1.7) * 0.08 + Math.sin(time * 37 + index) * 0.05 : 1;
        flame.scale.set(flicker, flicker, 1);
      });
      if (!motion) return;
      starsTexture.offset.y = (starsTexture.offset.y + dt * 0.04) % 1;
      const array = starGeometry.attributes.position.array as Float32Array;
      for (let index = 0; index < starCount; index++) {
        array[index * 3 + 2] += dt * (4 + (index % 5) * 1.5);
        if (array[index * 3 + 2] > 45) array[index * 3 + 2] -= 90;
      }
      starGeometry.attributes.position.needsUpdate = true;
    },
  };
}

function solarTexture(): THREE.CanvasTexture {
  return canvasTexture(128, (context, size) => {
    context.fillStyle = "#c9d2ea";
    context.fillRect(0, 0, size, size);
    const cell = size / 4;
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
      context.fillStyle = (row + column) % 2 ? "#1d2f6f" : "#22357a";
      context.fillRect(column * cell + 3, row * cell + 3, cell - 6, cell - 6);
      context.fillStyle = "rgba(160,190,255,0.18)";
      context.fillRect(column * cell + 5, row * cell + 5, cell - 10, 4);
    }
  });
}

/** Hardware bolted to the outside: solar wings, nav lights, sensor mast, thrusters, radiators. */
function buildExterior(): { root: THREE.Group; update(time: number, motion: boolean): void } {
  const root = new THREE.Group();
  const metal = plastic("#c3cadf", { metalness: 0.45, roughness: 0.35 });
  const dark = plastic("#3a4166", { roughness: 0.5 });
  const panelMaterial = new THREE.MeshStandardMaterial({ map: solarTexture(), roughness: 0.3, metalness: 0.35, side: THREE.DoubleSide });

  // Solar wings on trusses, port and starboard.
  const wings: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const boom = cylinder(0.09, 0.09, 2.4, metal, [side * 12.0, -0.35, -1.6], 10);
    boom.rotation.z = Math.PI / 2;
    root.add(boom, box(0.5, 0.5, 0.6, dark, [side * 10.95, -0.35, -1.6], 0.08));
    const wing = new THREE.Group();
    wing.position.set(side * 12.95, -0.35, -1.6);
    for (const z of [-1.55, 1.55]) {
      const panel = mesh(new THREE.PlaneGeometry(1.5, 2.6), panelMaterial, [0, 0, z], false);
      panel.rotation.x = -Math.PI / 2;
      panel.receiveShadow = true;
      wing.add(panel, box(1.56, 0.05, 0.06, metal, [0, 0, z - 1.3], 0.02), box(1.56, 0.05, 0.06, metal, [0, 0, z + 1.3], 0.02));
    }
    wing.add(cylinder(0.05, 0.05, 5.8, metal, [0, 0, 0], 8).rotateX(Math.PI / 2));
    wings.push(markDynamic(wing));
    root.add(wing);
  }

  // Radiator fins aft of the wings.
  for (const side of [-1, 1]) {
    for (let index = 0; index < 3; index++) {
      const fin = box(1.1, 0.04, 0.42, "#e5e9f3", [side * 11.35, -0.55, 2.6 + index * 0.62], 0.02);
      root.add(fin, box(1.12, 0.05, 0.05, "#ff8a3d", [side * 11.35, -0.52, 2.6 + index * 0.62], 0.01));
    }
    root.add(box(0.3, 0.3, 2.0, dark, [side * 10.85, -0.55, 3.22], 0.06));
  }

  // Sensor mast and dish on the nose.
  root.add(cylinder(0.06, 0.08, 1.6, metal, [0, -0.2, -8.55], 10).rotateX(Math.PI / 2));
  for (const x of [-0.5, 0.5]) root.add(sphere(0.16, "#e2e8f0", [x, -0.25, -8.25], 14));
  const noseDish = mesh(new THREE.SphereGeometry(0.42, 20, 8, 0, Math.PI * 2, 0, Math.PI / 3.2), metal, [0, -0.2, -9.35]);
  noseDish.rotation.x = -Math.PI / 2;
  root.add(noseDish);
  const strobe = sphere(0.07, uniqueMaterial("#ffffff", { emissive: "#ffffff", emissiveIntensity: 2 }), [0, -0.2, -9.45], 10);
  root.add(strobe);

  // Navigation lights: red to port, green to starboard.
  const port = sphere(0.13, uniqueMaterial("#ff4d4d", { emissive: "#ff3b3b", emissiveIntensity: 2 }), [-11.05, 0.25, -3.8], 12);
  const starboard = sphere(0.13, uniqueMaterial("#4dff88", { emissive: "#22e06a", emissiveIntensity: 2 }), [11.05, 0.25, -3.8], 12);
  root.add(port, starboard);

  // Thruster pods at the four corners.
  const plumes: THREE.Mesh[] = [];
  for (const [x, z, yaw] of [[-9.6, -6.55, Math.PI], [9.6, -6.55, Math.PI], [-9.9, 6.4, 0], [9.9, 6.4, 0]] as const) {
    const pod = new THREE.Group();
    pod.position.set(x, -0.45, z);
    pod.rotation.y = yaw;
    pod.add(box(0.6, 0.36, 0.4, dark, [0, 0, 0], 0.08));
    for (const offset of [-0.18, 0.18]) {
      const nozzle = mesh(new THREE.ConeGeometry(0.1, 0.22, 10, 1, true), metal, [offset, 0, 0.3]);
      nozzle.rotation.x = -Math.PI / 2;
      pod.add(nozzle);
      const plume = mesh(new THREE.ConeGeometry(0.09, 0.5, 10, 1, true), new THREE.MeshBasicMaterial({ color: "#bfe9ff", transparent: true, opacity: 0, depthWrite: false }), [offset, 0, 0.62], false);
      plume.rotation.x = Math.PI / 2;
      plumes.push(plume);
      pod.add(plume);
    }
    root.add(pod);
  }

  // Docking port on the port side.
  const dock = new THREE.Group();
  dock.position.set(-10.95, -0.4, 2.0);
  dock.add(cylinder(0.55, 0.55, 0.5, metal, [0, 0, 0], 24).rotateZ(Math.PI / 2));
  dock.add(mesh(new THREE.TorusGeometry(0.55, 0.08, 10, 28), plastic("#ffb224"), [-0.28, 0, 0]).rotateY(Math.PI / 2));
  root.add(dock);

  return {
    root,
    update(time, motion) {
      const blink = (period: number, offset: number) => (motion ? ((time + offset) % period) < 0.18 : true);
      (port.material as THREE.MeshStandardMaterial).emissiveIntensity = blink(1.6, 0) ? 2.6 : 0.3;
      (starboard.material as THREE.MeshStandardMaterial).emissiveIntensity = blink(1.6, 0.8) ? 2.6 : 0.3;
      (strobe.material as THREE.MeshStandardMaterial).emissiveIntensity = blink(2.2, 0.3) ? 3 : 0.2;
      plumes.forEach((plume, index) => {
        const burst = motion ? Math.max(0, Math.sin(time * 0.9 + index * 2.3) - 0.93) * 12 : 0;
        (plume.material as THREE.MeshBasicMaterial).opacity = Math.min(0.75, burst);
      });
      if (motion) for (const [index, wing] of wings.entries()) wing.rotation.z = Math.sin(time * 0.15 + index) * 0.08;
    },
  };
}
