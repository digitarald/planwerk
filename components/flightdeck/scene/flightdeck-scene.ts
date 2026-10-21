import * as THREE from "three";
import { CREW_COLORS, type CrewMember, type StationId } from "@/lib/flightdeck/crew";
import { buildHull } from "./hull";
import { mergeStatic } from "./bake";
import { buildRooms } from "./rooms";
import { damp, dampAngle, disposeObject, disposeSharedMaterials, easeOutBack, glow } from "./kit";
import {
  AIRLOCK, TABLE_CENTER, bridgeSlot, loungeSpot, roomLabelPoint, route, stationPosition, workSlot, yawToward,
  type Leisure, type WorkStationId,
} from "./layout";
import { applyRisk, BUDDY_HEIGHT, buildBuddy, buildRobot, poseBuddy, type BuddyRig, type Robot } from "./models";
import { spinHats } from "./hats";
import { buildStations, type Effects } from "./stations";

export interface FlightdeckSceneOptions {
  container: HTMLElement;
  reducedMotion: boolean;
  onHover(id: string | null): void;
  onSelect(id: string): void;
  /** A buddy actually heads back to work (or newly boards and starts working). */
  onActivate?(id: string): void;
}

export interface FlightdeckScene {
  setCrew(members: readonly CrewMember[]): void;
  setLabel(id: string, element: HTMLElement | null): void;
  setStationLabel(id: StationId, element: HTMLElement | null): void;
  setHighlighted(id: string | null): void;
  setReducedMotion(reduced: boolean): void;
  dispose(): void;
}

interface Agent {
  /** What the buddy is acting on; lags `desired` so brief flickers don't send it walking. */
  member: CrewMember;
  desired: CrewMember;
  desiredSince: number;
  arrivedAt: number;
  speed: number;
  buddy: BuddyRig;
  robots: Robot[];
  path: THREE.Vector3[];
  target: THREE.Vector3;
  facing: number;
  seated: boolean;
  leisure?: Leisure;
  loungeIndex?: number;
  appear: number;
  leaving: boolean;
  offset: number;
  hopTimer: number;
  nextEffect: number;
}

const WALK_SPEED = 2.7;
const MAX_WALK_SPEED = 6.5;
/** Minimum time at a post before another work station can pull the buddy away. */
const MIN_DWELL = 3;

const keyOf = (member: CrewMember) => `${member.mode}:${member.station}`;
const now = () => performance.now() / 1000;

/** How long a new destination must hold before the buddy acts on it. */
function commitDelay(from: CrewMember, to: CrewMember): number {
  if (to.mode === "reporting") return 0.6;
  if (to.mode === "fault") return 1.5;
  if (to.mode === "resting") return 8;
  if (from.mode === "resting") return 0.4;
  return 2.5;
}

function pathLength(from: THREE.Vector3, path: THREE.Vector3[]): number {
  let total = 0;
  let previous = from;
  for (const point of path) { total += previous.distanceTo(point); previous = point; }
  return total;
}
const MAX_ROBOTS = 5;
const LABEL_HEIGHT = BUDDY_HEIGHT + 0.12;
/** Chunky, Overcooked-scale crew relative to the stations. */
const CREW_SCALE = 1.18;

export function createFlightdeckScene(options: FlightdeckSceneOptions): FlightdeckScene {
  const { container } = options;
  let motion = !options.reducedMotion;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  // Resolution adapts to the device: start sharp and step down only while frames run slow.
  let maxPixelRatio = Math.min(window.devicePixelRatio, 2);
  let pixelRatio = maxPixelRatio;
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = "block";
  renderer.domElement.setAttribute("aria-hidden", "true");
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 220);
  const lookAt = new THREE.Vector3(0, 0, 0.4);
  const viewDirection = new THREE.Vector3(0, 21, 14.5).normalize();
  let viewDistance = 25;

  scene.add(new THREE.HemisphereLight("#cfe0ff", "#2b2250", 1.15));
  const sun = new THREE.DirectionalLight("#fff1dc", 2.3);
  sun.position.set(-7, 16, 9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 12, bottom: -12, near: 1, far: 50 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  scene.add(sun);
  const rim = new THREE.DirectionalLight("#7c9cff", 0.7);
  rim.position.set(8, 6, -10);
  scene.add(rim);
  const bridgeLight = new THREE.PointLight("#7dd3fc", 6, 7, 1.6);
  bridgeLight.position.set(TABLE_CENTER.x, 2.1, TABLE_CENTER.z);
  scene.add(bridgeLight);

  const hull = buildHull();
  scene.add(hull.root);
  const rooms = buildRooms();
  scene.add(rooms.root);
  const stations = buildStations();
  for (const station of stations) scene.add(station.group);
  // Everything that never moves collapses into one draw call per material.
  const staticRoot = new THREE.Group();
  scene.add(staticRoot);
  mergeStatic([hull.root, rooms.root, ...stations.map((station) => station.group)], staticRoot);

  // ── Effects: pooled particles and waves ──
  interface Particle { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number; maxLife: number; gravity: number; grow: number }
  const particleGeometry = new THREE.SphereGeometry(1, 8, 6);
  const particles: Particle[] = [];
  const freeParticles: THREE.Mesh[] = [];
  function particle(at: THREE.Vector3, color: THREE.ColorRepresentation, velocity: THREE.Vector3, life: number, size: number, gravity: number, grow: number, opacity = 1) {
    if (particles.length > 220) return;
    const item = freeParticles.pop() ?? new THREE.Mesh(particleGeometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    const material = item.material as THREE.MeshBasicMaterial;
    material.color.set(color);
    material.opacity = opacity;
    item.userData.opacity = opacity;
    item.position.copy(at);
    item.scale.setScalar(size);
    item.visible = true;
    scene.add(item);
    particles.push({ mesh: item, velocity, life, maxLife: life, gravity, grow });
  }
  interface Wave { mesh: THREE.Mesh; life: number }
  const waves: Wave[] = [];
  const effects: Effects = {
    sparks(at, color = "#ffd166") {
      for (let index = 0; index < 6; index++) {
        const velocity = new THREE.Vector3((Math.random() - 0.5) * 2.4, 1.2 + Math.random() * 1.6, (Math.random() - 0.5) * 2.4);
        particle(at, index % 2 ? color : "#fff3c4", velocity, 0.45 + Math.random() * 0.25, 0.035, 7, 0);
      }
    },
    puff(at, color = "#e2e8f0", rise = 0.7) {
      particle(at, color, new THREE.Vector3((Math.random() - 0.5) * 0.15, rise, (Math.random() - 0.5) * 0.15), 1.6, 0.08, 0, 0.12, 0.7);
    },
    wave(at, color) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.025, 6, 32), glow(color, 0.9));
      ring.position.copy(at);
      ring.rotation.x = -Math.PI / 2 + 0.5;
      scene.add(ring);
      waves.push({ mesh: ring, life: 1.4 });
    },
  };
  function updateEffects(dt: number) {
    for (let index = particles.length - 1; index >= 0; index--) {
      const item = particles[index];
      item.life -= dt;
      if (item.life <= 0) {
        item.mesh.visible = false;
        scene.remove(item.mesh);
        freeParticles.push(item.mesh);
        particles.splice(index, 1);
        continue;
      }
      item.velocity.y -= item.gravity * dt;
      item.mesh.position.addScaledVector(item.velocity, dt);
      item.mesh.scale.addScalar(item.grow * dt);
      (item.mesh.material as THREE.MeshBasicMaterial).opacity = (item.mesh.userData.opacity as number) * (item.life / item.maxLife);
    }
    for (let index = waves.length - 1; index >= 0; index--) {
      const wave = waves[index];
      wave.life -= dt;
      const progress = 1 - wave.life / 1.4;
      wave.mesh.scale.setScalar(1 + progress * 3.2);
      (wave.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - progress);
      if (wave.life <= 0) {
        scene.remove(wave.mesh);
        disposeObject(wave.mesh);
        waves.splice(index, 1);
      }
    }
  }

  // ── Crew ──
  const agents = new Map<string, Agent>();
  const labels = new Map<string, HTMLElement>();
  const stationLabels = new Map<StationId, HTMLElement>();
  let initialized = false;
  let highlighted: string | null = null;
  let hovered: string | null = null;

  function placement(member: CrewMember, index: number): { position: THREE.Vector3; seated: boolean; yaw?: number; leisure?: Leisure } {
    if (member.station === "bridge") return { position: bridgeSlot(index), seated: false };
    if (member.station === "lounge") {
      const spot = loungeSpot(index);
      return { position: spot.position, seated: spot.seated, yaw: spot.yaw, leisure: spot.leisure };
    }
    return { position: workSlot(member.station as WorkStationId, index), seated: false };
  }

  function facingFor(agent: Agent, yaw?: number): number {
    const { station } = agent.member;
    if (yaw !== undefined) return yaw;
    if (station === "bridge") return yawToward(agent.target, TABLE_CENTER);
    if (station === "lounge") return yawToward(agent.target, new THREE.Vector3());
    return yawToward(agent.target, stationPosition(station as WorkStationId));
  }

  function createAgent(member: CrewMember, at: THREE.Vector3): Agent {
    const buddy = buildBuddy(CREW_COLORS[member.colorIndex], member.id);
    buddy.root.position.copy(at);
    scene.add(buddy.root);
    return {
      member, desired: member, desiredSince: now(), arrivedAt: now(), speed: WALK_SPEED,
      buddy, robots: [], path: [], target: at.clone(), facing: 0, seated: false,
      appear: 0, leaving: false, offset: Math.random() * 10, hopTimer: 0, nextEffect: 0,
    };
  }

  function removeAgent(agent: Agent) {
    scene.remove(agent.buddy.root);
    disposeObject(agent.buddy.root);
    for (const robot of agent.robots) { scene.remove(robot.root); disposeObject(robot.root); }
    agents.delete(agent.member.id);
  }

  function walk(agent: Agent, to: THREE.Vector3) {
    const from = agent.buddy.root.position;
    agent.path = route(from, to);
    agent.speed = THREE.MathUtils.clamp(WALK_SPEED + (pathLength(from, agent.path) - 4) * 0.35, WALK_SPEED, MAX_WALK_SPEED);
  }

  /** Assign posts from committed members and reroute anyone whose post moved. */
  function relayout() {
    const counts = new Map<StationId, number>();
    const committed = [...agents.values()].filter((agent) => !agent.leaving).sort((a, b) => a.member.id.localeCompare(b.member.id));
    for (const agent of committed) {
      const { member } = agent;
      const index = counts.get(member.station) ?? 0;
      counts.set(member.station, index + 1);
      const spot = placement(member, index);
      if (agent.target.distanceTo(spot.position) > 0.05) {
        agent.target = spot.position.clone();
        if (motion) walk(agent, spot.position);
        else { agent.path = []; agent.buddy.root.position.copy(spot.position); }
      }
      agent.seated = spot.seated;
      agent.leisure = spot.leisure;
      agent.loungeIndex = member.station === "lounge" ? index : undefined;
      agent.facing = facingFor(agent, spot.yaw);
      applyRisk(agent.buddy, member.risk, member.mode !== "resting");
    }
  }

  function setCrew(members: readonly CrewMember[]) {
    const seen = new Set<string>();
    const time = now();
    for (const member of members) {
      seen.add(member.id);
      let agent = agents.get(member.id);
      if (!agent) {
        agent = createAgent(member, AIRLOCK);
        agents.set(member.id, agent);
        // Initial crew pops in staggered at their posts; later arrivals pop out of the airlock.
        agent.appear = !motion ? 1 : initialized ? 0 : -Math.random() * 0.6;
        if (initialized && member.mode !== "resting") options.onActivate?.(member.id);
        agent.target.set(Infinity, 0, Infinity);
        if (!initialized || !motion) agent.buddy.root.position.set(Infinity, 0, Infinity);
      }
      if (keyOf(member) !== keyOf(agent.desired)) agent.desiredSince = time;
      agent.desired = member;
      agent.leaving = false;
      // Identity, risk and helpers apply immediately; only the post change waits.
      agent.member = keyOf(member) === keyOf(agent.member) || !motion ? member : { ...member, mode: agent.member.mode, station: agent.member.station };
    }
    for (const agent of agents.values()) {
      if (seen.has(agent.member.id) || agent.leaving) continue;
      if (!motion) { removeAgent(agent); continue; }
      agent.leaving = true;
      agent.seated = false;
      agent.member = { ...agent.member, helpers: 0, mode: "working" };
      agent.target = AIRLOCK.clone();
      walk(agent, AIRLOCK);
    }
    relayout();
    // First placement: drop newcomers straight onto their posts.
    for (const agent of agents.values()) {
      if (Number.isFinite(agent.buddy.root.position.x)) continue;
      agent.buddy.root.position.copy(agent.target);
      agent.path = [];
    }
    initialized = true;
  }

  /** Commit destinations that have held long enough. */
  function commitPending() {
    const time = now();
    let changed = false;
    for (const agent of agents.values()) {
      if (agent.leaving || keyOf(agent.desired) === keyOf(agent.member)) continue;
      const settled = agent.path.length === 0;
      const workToWork = agent.desired.mode === "working" && agent.member.mode === "working";
      if (workToWork && settled && time - agent.arrivedAt < MIN_DWELL) continue;
      if (time - agent.desiredSince < commitDelay(agent.member, agent.desired)) continue;
      if (agent.member.mode === "resting") options.onActivate?.(agent.desired.id);
      agent.member = agent.desired;
      changed = true;
    }
    if (changed) relayout();
  }

  const robotAnchor = new THREE.Vector3();
  function updateRobots(agent: Agent, dt: number, time: number) {
    const wanted = Math.min(agent.member.helpers, MAX_ROBOTS);
    const live = agent.robots.filter((robot) => !robot.leaving);
    for (let index = live.length; index < wanted; index++) {
      const robot = buildRobot(CREW_COLORS[agent.member.colorIndex]);
      agent.buddy.anchor.getWorldPosition(robot.root.position);
      scene.add(robot.root);
      agent.robots.push(robot);
    }
    for (let index = wanted; index < live.length; index++) live[index].leaving = true;
    const active = agent.robots.filter((robot) => !robot.leaving);
    const root = agent.buddy.root;
    agent.buddy.anchor.getWorldPosition(robotAnchor);
    for (let index = agent.robots.length - 1; index >= 0; index--) {
      const robot = agent.robots[index];
      robot.presence = motion
        ? THREE.MathUtils.clamp(robot.presence + (robot.leaving ? -dt * 2.6 : dt * 2), 0, 1)
        : (robot.leaving ? 0 : 1);
      if (robot.leaving && robot.presence <= 0) {
        scene.remove(robot.root);
        disposeObject(robot.root);
        agent.robots.splice(index, 1);
        continue;
      }
      const slot = active.indexOf(robot);
      const count = Math.max(1, active.length);
      const spread = slot < 0 ? 0 : (slot - (count - 1) / 2) * 0.85;
      const angle = root.rotation.y + Math.PI + spread;
      const radius = (0.78 + (count > 3 ? 0.12 : 0)) * CREW_SCALE;
      const bob = motion ? Math.sin(time * 2.2 + robot.seed) * 0.07 : 0;
      const desired = new THREE.Vector3(
        root.position.x + Math.sin(angle) * radius,
        root.position.y + (1.05 + (slot % 2) * 0.12) * CREW_SCALE + bob,
        root.position.z + Math.cos(angle) * radius,
      );
      if (robot.leaving || robot.presence < 1) desired.lerp(robotAnchor, 1 - robot.presence);
      if (motion) robot.root.position.lerp(desired, 1 - Math.exp(-dt * 5));
      else robot.root.position.copy(desired);
      robot.root.rotation.y = dampAngle(robot.root.rotation.y, root.rotation.y + Math.sin(time * 0.7 + robot.seed) * 0.4, 4, dt);
      robot.root.scale.setScalar(Math.max(0.001, (motion ? easeOutBack(robot.presence) : robot.presence) * CREW_SCALE));
      robot.thrust.scale.y = motion ? 0.8 + Math.sin(time * 30 + robot.seed) * 0.2 : 1;
    }
  }

  const stationCounts = new Map<StationId, number>();
  const loungeOccupied = new Set<number>();
  const step = new THREE.Vector3();
  function updateAgents(dt: number, time: number) {
    commitPending();
    stationCounts.clear();
    loungeOccupied.clear();
    for (const agent of [...agents.values()]) {
      const root = agent.buddy.root;
      const { member } = agent;
      let walking = false;
      if (agent.appear < 1) {
        agent.appear = Math.min(1, agent.appear + dt * 2.2);
        root.scale.setScalar(Math.max(0.001, easeOutBack(Math.max(0, agent.appear)) * CREW_SCALE));
      }
      if (agent.path.length > 0 && agent.appear > 0.4) {
        const next = agent.path[0];
        step.subVectors(next, root.position);
        step.y = 0;
        const distance = step.length();
        const travel = agent.speed * dt;
        if (distance <= travel) {
          root.position.copy(next);
          agent.path.shift();
          if (agent.path.length === 0) agent.arrivedAt = now();
        } else {
          root.position.addScaledVector(step.normalize(), travel);
        }
        walking = agent.path.length > 0 || distance > travel;
        if (distance > 0.01) root.rotation.y = dampAngle(root.rotation.y, Math.atan2(step.x, step.z), 12, dt);
      } else {
        root.rotation.y = motion ? dampAngle(root.rotation.y, agent.facing, 7, dt) : agent.facing;
      }
      if (agent.leaving && agent.path.length === 0) {
        agent.appear = Math.max(0, agent.appear - dt * 3);
        root.scale.setScalar(Math.max(0.001, agent.appear * CREW_SCALE));
        if (agent.appear <= 0.02 && agent.robots.length === 0) { removeAgent(agent); continue; }
      }
      const arrived = !walking && agent.path.length === 0;
      if (arrived && !agent.leaving && (member.mode === "working" || member.mode === "fault" || member.mode === "reporting")) {
        stationCounts.set(member.station, (stationCounts.get(member.station) ?? 0) + 1);
      }
      if (arrived && member.mode === "resting" && agent.loungeIndex !== undefined) loungeOccupied.add(agent.loungeIndex);

      poseBuddy(agent.buddy, {
        mode: member.mode, station: member.station, walking, seated: arrived && agent.seated,
        time: time + agent.offset, clock: time, leisure: agent.leisure, motion,
        pace: agent.speed / WALK_SPEED,
      });
      const emphasis = hovered === member.id || highlighted === member.id;
      agent.buddy.halo.visible = emphasis;
      if (agent.appear >= 1 && !agent.leaving) root.scale.setScalar(damp(root.scale.x, (emphasis ? 1.08 : 1) * CREW_SCALE, 10, dt));

      if (motion && arrived && member.mode === "fault") {
        agent.nextEffect -= dt;
        if (agent.nextEffect <= 0) {
          agent.nextEffect = 0.28;
          const head = root.position.clone().add(new THREE.Vector3(0, 0.95 * CREW_SCALE, 0));
          effects.puff(head, Math.random() > 0.3 ? "#6b7280" : "#374151", 0.8);
          if (Math.random() > 0.55) effects.sparks(head, "#ff6369");
        }
      }
      updateRobots(agent, dt, time);
    }
  }

  // ── Picking ──
  // Each buddy carries an invisible capsule; rays test those instead of every hat and tool.
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerInside = false;
  let pointerMoved = false;
  let lastPick = 0;
  function pick(): string | null {
    if (!pointerInside) return null;
    raycaster.setFromCamera(pointer, camera);
    const proxies = [...agents.values()].filter((agent) => !agent.leaving).map((agent) => agent.buddy.hitProxy);
    const hit = raycaster.intersectObjects(proxies, false)[0];
    return (hit?.object.userData.crewId as string | undefined) ?? null;
  }
  const onPointerMove = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    pointerInside = true;
    pointerMoved = true;
  };
  const onPointerLeave = () => { pointerInside = false; };
  const onClick = () => { const id = pick(); if (id) options.onSelect(id); };
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerleave", onPointerLeave);
  renderer.domElement.addEventListener("click", onClick);

  // ── Layout ──
  function resize() {
    // Zoom or a move to another display changes the device ratio.
    const deviceRatio = Math.min(window.devicePixelRatio, 2);
    if (deviceRatio !== maxPixelRatio) {
      if (pixelRatio === maxPixelRatio || pixelRatio > deviceRatio) pixelRatio = deviceRatio;
      maxPixelRatio = deviceRatio;
      renderer.setPixelRatio(pixelRatio);
    }
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    renderer.domElement.style.width = `${width}px`;
    renderer.domElement.style.height = `${height}px`;
    camera.aspect = width / height;
    viewDistance = 29 * Math.max(1, 1.85 / camera.aspect);
    camera.updateProjectionMatrix();
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  const projected = new THREE.Vector3();
  function placeLabel(element: HTMLElement, world: THREE.Vector3, width: number, height: number) {
    projected.copy(world).project(camera);
    const x = ((projected.x + 1) / 2) * width;
    const y = ((1 - projected.y) / 2) * height;
    element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }
  const labelPoint = new THREE.Vector3();
  function updateLabels() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    for (const [id, element] of labels) {
      const agent = agents.get(id);
      if (!agent) { element.style.opacity = "0"; continue; }
      const root = agent.buddy.root;
      labelPoint.set(root.position.x, root.position.y + LABEL_HEIGHT * root.scale.y + (agent.seated && agent.path.length === 0 ? -0.3 : 0), root.position.z);
      placeLabel(element, labelPoint, width, height);
      element.style.opacity = agent.leaving ? "0" : String(Math.min(1, Math.max(0, agent.appear)));
    }
    for (const [id, element] of stationLabels) placeLabel(element, roomLabelPoint(id), width, height);
  }

  // ── Adaptive resolution ──
  // Every 2 s: below ~45 fps drop a step. Stepping back up needs 20 s of headroom, and a
  // ratio that was too slow waits a minute before it is retried, so a frame-rate cap
  // (60 Hz displays, throttled tabs) can't make the canvas flip back and forth.
  const PIXEL_RATIO_STEPS = [2, 1.75, 1.5, 1.25, 1];
  let frameBudget = { frames: 0, time: 0 };
  let fastWindows = 0;
  const failedAt = new Map<number, number>();
  function adaptResolution(frameTime: number) {
    frameBudget.frames++;
    frameBudget.time += frameTime;
    if (frameBudget.time < 2) return;
    const average = frameBudget.time / frameBudget.frames;
    frameBudget = { frames: 0, time: 0 };
    const steps = PIXEL_RATIO_STEPS.filter((step) => step <= maxPixelRatio);
    const index = Math.max(0, steps.indexOf(pixelRatio));
    let next: number | undefined;
    if (average > 1 / 45) {
      fastWindows = 0;
      next = steps[index + 1];
      if (next !== undefined) failedAt.set(pixelRatio, performance.now());
    } else if (average < 1 / 58 && ++fastWindows >= 10) {
      fastWindows = 0;
      const candidate = steps[index - 1];
      if (candidate !== undefined && performance.now() - (failedAt.get(candidate) ?? -Infinity) > 60_000) next = candidate;
    }
    if (next === undefined) return;
    pixelRatio = next;
    renderer.setPixelRatio(pixelRatio);
    resize();
  }

  // ── Loop ──
  const clock = new THREE.Clock();
  let elapsed = 0;
  let frame = 0;
  let disposed = false;
  function render() {
    if (disposed) return;
    frame = requestAnimationFrame(render);
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    elapsed += dt;
    // Hidden tabs produce huge gaps; only steady frames inform the resolution.
    if (rawDt < 0.25 && !stats) adaptResolution(rawDt);
    const drift = motion ? Math.sin(elapsed * 0.11) * 0.35 : 0;
    camera.position.copy(lookAt).addScaledVector(viewDirection, viewDistance);
    camera.position.x += drift;
    camera.lookAt(lookAt);

    updateAgents(dt, elapsed);
    // Re-pick on pointer moves, and a few times a second while crew walk under a still pointer.
    const now = performance.now();
    const hit = pointerMoved || now - lastPick > 150 ? pick() : hovered;
    if (pointerMoved || now - lastPick > 150) { pointerMoved = false; lastPick = now; }
    if (hit !== hovered) {
      hovered = hit;
      renderer.domElement.style.cursor = hit ? "pointer" : "default";
      options.onHover(hit);
    }
    for (const station of stations) {
      station.animate(dt, elapsed, stationCounts.get(station.id) ?? 0, motion, effects, station.id === "lounge" ? loungeOccupied : undefined);
    }
    const reporting = stationCounts.get("bridge") ?? 0;
    bridgeLight.color.set(reporting ? "#fbbf24" : "#7dd3fc");
    bridgeLight.intensity = reporting ? 8 + (motion ? Math.sin(elapsed * 4) * 2 : 0) : 5;
    hull.update(dt, elapsed, motion);
    rooms.update(dt, elapsed, motion);
    if (motion) for (const agent of agents.values()) spinHats(agent.buddy.root, dt * 14);
    if (motion) updateEffects(dt);
    const started = stats ? performance.now() : 0;
    if (stats) renderer.info.reset();
    renderer.render(scene, camera);
    if (stats) {
      // finish() blocks until the GPU is done so the timing covers the whole frame.
      renderer.getContext().finish();
      stats.frames++;
      stats.cpu += performance.now() - started;
      stats.calls += renderer.info.render.calls;
      stats.triangles += renderer.info.render.triangles;
    }
    updateLabels();
  }
  // `?stats` exposes per-frame cost for performance work.
  const stats = typeof location !== "undefined" && new URLSearchParams(location.search).has("stats")
    ? { frames: 0, cpu: 0, calls: 0, triangles: 0 }
    : undefined;
  if (stats) {
    renderer.info.autoReset = false;
    Reflect.set(window, "__flightdeckStats", () => ({
      frames: stats.frames,
      msPerFrame: +(stats.cpu / Math.max(1, stats.frames)).toFixed(2),
      drawCalls: Math.round(stats.calls / Math.max(1, stats.frames)),
      triangles: Math.round(stats.triangles / Math.max(1, stats.frames)),
      programs: renderer.info.programs?.length ?? 0,
      geometries: renderer.info.memory.geometries,
      pixelRatio: renderer.getPixelRatio(),
    }));
    Reflect.set(window, "__flightdeckStatsReset", () => Object.assign(stats, { frames: 0, cpu: 0, calls: 0, triangles: 0 }));
  }
  render();

  return {
    setCrew,
    setLabel(id, element) {
      if (element) labels.set(id, element);
      else labels.delete(id);
    },
    setStationLabel(id, element) {
      if (element) stationLabels.set(id, element);
      else stationLabels.delete(id);
    },
    setHighlighted(id) { highlighted = id; },
    setReducedMotion(reduced) {
      motion = !reduced;
      if (motion) return;
      // Settle everything immediately instead of freezing mid-animation.
      for (const item of particles) { item.mesh.visible = false; scene.remove(item.mesh); freeParticles.push(item.mesh); }
      particles.length = 0;
      for (const wave of waves) { scene.remove(wave.mesh); disposeObject(wave.mesh); }
      waves.length = 0;
      for (const agent of [...agents.values()]) {
        if (agent.leaving) { removeAgent(agent); continue; }
        agent.member = agent.desired;
      }
      relayout();
      for (const agent of agents.values()) {
        agent.path = [];
        agent.appear = 1;
        agent.buddy.root.position.copy(agent.target);
        agent.buddy.root.scale.setScalar(CREW_SCALE);
      }
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("click", onClick);
      for (const item of particles) scene.remove(item.mesh);
      particleGeometry.dispose();
      for (const item of [...freeParticles, ...particles.map((entry) => entry.mesh)]) (item.material as THREE.Material).dispose();
      disposeObject(scene);
      disposeSharedMaterials();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
