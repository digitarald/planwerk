"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, Bot, Coffee, MessageCircleQuestion, Rocket, ShieldAlert } from "lucide-react";

import { buildCrew, CREW_COLORS, STATION_NAMES, type CrewMember, type StationId } from "@/lib/flightdeck/crew";
import { demoCrew } from "@/lib/flightdeck/demo";
import { selectFilteredCards, useBoardStore } from "@/lib/store/board-store";
import { cn } from "@/lib/utils";
import type { FlightdeckScene } from "./scene/flightdeck-scene";

const STATION_LABELS: StationId[] = ["archive", "scanner", "planning", "engineering", "fabricator", "diagnostics", "comms", "lounge", "bridge"];

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
const subscribeReducedMotion = (onChange: () => void) => {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const readReducedMotion = () => window.matchMedia(reducedMotionQuery).matches;

export function FlightdeckView() {
  const cards = useBoardStore(useShallow(selectFilteredCards));
  const setDetailCard = useBoardStore((state) => state.setDetailCard);
  const demo = useSyncExternalStore(() => () => {}, () => new URLSearchParams(window.location.search).has("demo"), () => false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!demo) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 4000);
    return () => window.clearInterval(timer);
  }, [demo]);
  const crew = useMemo(() => (demo ? demoCrew(tick) : buildCrew(cards)), [demo, tick, cards]);
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);

  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<FlightdeckScene | null>(null);
  const crewRef = useRef(crew);
  const selectRef = useRef(setDetailCard);
  // The canvas and the DOM labels/manifest report hover separately; either keeps a member highlighted.
  const [sceneHover, setSceneHover] = useState<string | null>(null);
  const [domHover, setHovered] = useState<string | null>(null);
  const hovered = domHover ?? sceneHover;
  const [failed, setFailed] = useState(false);
  const [activations, setActivations] = useState<Record<string, number>>({});

  useEffect(() => { crewRef.current = crew; sceneRef.current?.setCrew(crew.members); }, [crew]);
  useEffect(() => { selectRef.current = setDetailCard; }, [setDetailCard]);
  useEffect(() => { sceneRef.current?.setReducedMotion(reducedMotion); }, [reducedMotion]);
  useEffect(() => { sceneRef.current?.setHighlighted(hovered); }, [hovered]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let cancelled = false;
    let scene: FlightdeckScene | null = null;
    import("./scene/flightdeck-scene").then(({ createFlightdeckScene }) => {
      if (cancelled) return;
      scene = createFlightdeckScene({
        container: stage,
        reducedMotion: readReducedMotion(),
        onHover: setSceneHover,
        onSelect: (id) => selectRef.current(id),
        onActivate: (id) => setActivations((previous) => ({ ...previous, [id]: (previous[id] ?? 0) + 1 })),
      });
      sceneRef.current = scene;
      for (const element of stage.querySelectorAll<HTMLElement>("[data-crew-label]")) scene.setLabel(element.dataset.crewLabel!, element);
      for (const element of stage.querySelectorAll<HTMLElement>("[data-station-label]")) scene.setStationLabel(element.dataset.stationLabel as StationId, element);
      scene.setCrew(crewRef.current.members);
    }).catch((error: unknown) => {
      console.error("[flightdeck] 3D scene unavailable", error);
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      scene?.dispose();
      sceneRef.current = null;
    };
  }, []);

  const empty = crew.members.length === 0;

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_300px] max-[900px]:grid-cols-1">
      <section
        ref={stageRef}
        aria-label="Flightdeck: agents at work"
        className="flightdeck-stage relative min-h-0 overflow-hidden"
      >
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          {STATION_LABELS.map((station) => (
            <div
              key={station}
              data-station-label={station}
              ref={(element) => sceneRef.current?.setStationLabel(station, element)}
              className="absolute left-0 top-0 will-change-transform"
            >
              <span className="block -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-[#141936]/70 px-2 py-0.5 text-[10px] font-medium tracking-wide text-[#c7d2fe]">
                {STATION_NAMES[station]}
              </span>
            </div>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-0">
          {crew.members.map((member) => (
            <CrewLabel
              key={member.id}
              member={member}
              activation={activations[member.id] ?? 0}
              expanded={hovered === member.id}
              register={(element) => sceneRef.current?.setLabel(member.id, element)}
              onHover={setHovered}
              onSelect={() => setDetailCard(member.id)}
            />
          ))}
        </div>
        {(empty || failed) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center px-6">
            <div className="max-w-sm rounded-2xl bg-[#141936]/85 px-5 py-4 text-center text-[#e0e7ff] shadow-[0_12px_32px_-12px_rgba(0,0,0,0.6)]">
              <p className="text-sm font-semibold">{failed ? "The flightdeck couldn't start" : "The deck is quiet"}</p>
              <p className="mt-1 text-xs leading-relaxed text-[#c7d2fe]">
                {failed
                  ? "This device couldn't render the 3D view. The crew list still shows every agent."
                  : "Agents come aboard as soon as a session starts. Each one works at the station that matches what it's doing."}
              </p>
            </div>
          </div>
        )}
      </section>
      <CrewManifest members={crew.members} offDuty={crew.offDuty} highlighted={hovered} onHover={setHovered} onSelect={setDetailCard} />
    </div>
  );
}

function CrewLabel({ member, activation, expanded, register, onHover, onSelect }: {
  member: CrewMember;
  /** Bumps each time the buddy actually heads back to work. */
  activation: number;
  expanded: boolean;
  register: (element: HTMLElement | null) => void;
  onHover: (id: string | null) => void;
  onSelect: () => void;
}) {
  const color = CREW_COLORS[member.colorIndex];
  const reporting = member.mode === "reporting";
  const fault = member.mode === "fault";
  // A changed title or a buddy heading back to work gets a brief announcement;
  // otherwise the name only shows on hover.
  const [seen, setSeen] = useState({ title: member.title, activation });
  const [announcement, setAnnouncement] = useState(0);
  const [announcing, setAnnouncing] = useState(false);
  if (seen.title !== member.title || seen.activation !== activation) {
    setSeen({ title: member.title, activation });
    setAnnouncing(true);
    setAnnouncement((value) => value + 1);
  }
  const showName = expanded || announcing;
  return (
    <div
      ref={register}
      data-crew-label={member.id}
      className="absolute left-0 top-0 opacity-0 will-change-transform"
      style={{ zIndex: expanded ? 20 : reporting || fault ? 10 : 1 }}
    >
      <div className="flex -translate-x-1/2 -translate-y-full flex-col items-center gap-1">
        {(reporting || fault) && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            title={`${member.title}: ${member.task}`}
            onPointerEnter={() => onHover(member.id)}
            onPointerLeave={() => onHover(null)}
            onClick={onSelect}
            className={cn(
              "pointer-events-auto flex h-7 w-7 items-center justify-center rounded-full shadow-[0_4px_12px_-2px_rgba(0,0,0,0.45)] transition-transform duration-150 hover:scale-110 motion-safe:animate-[flightdeck-bob_1.6s_ease-in-out_infinite]",
              reporting ? "bg-[#ffc53d] text-[#3d2a00]" : "bg-[#e5484d] text-white",
            )}
          >
            {reporting ? <MessageCircleQuestion className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          </button>
        )}
        {showName && (
          <button
            key={expanded ? "hover" : `announce:${announcement}`}
            type="button"
            tabIndex={-1}
            aria-hidden
            onPointerEnter={() => onHover(member.id)}
            onPointerLeave={() => onHover(null)}
            onClick={onSelect}
            onAnimationEnd={() => setAnnouncing(false)}
            className={cn(
              "flex max-w-[220px] items-center gap-1.5 rounded-full bg-white py-1 pl-2 pr-2.5 text-[#1b1f3b] shadow-[0_6px_16px_-6px_rgba(0,0,0,0.55)]",
              expanded ? "pointer-events-auto" : "pointer-events-none animate-[flightdeck-announce_6s_ease-out_forwards]",
            )}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="truncate text-[11px] font-semibold leading-tight">{member.title}</span>
            {member.risk === "high" && <ShieldAlert className="h-3 w-3 shrink-0 text-[#d97706]" aria-label="High risk" />}
            {member.helpers > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 text-[10px] font-semibold text-[#4f5bd5]">
                <Bot className="h-3 w-3" />{member.helpers}
              </span>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function CrewManifest({ members, offDuty, highlighted, onHover, onSelect }: {
  members: CrewMember[];
  offDuty: number;
  highlighted: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const reporting = members.filter((member) => member.mode === "reporting");
  const faults = members.filter((member) => member.mode === "fault");
  const working = members.filter((member) => member.mode === "working");
  const resting = members.filter((member) => member.mode === "resting");
  const helpers = working.reduce((total, member) => total + member.helpers, 0);
  const groups: Array<{ title: string; members: CrewMember[] }> = [
    { title: "Waiting at mission control", members: reporting },
    { title: "Faults", members: faults },
    { title: "On duty", members: working },
    { title: "In the lounge", members: resting },
  ];

  return (
    <aside aria-label="Crew manifest" className="flex min-h-0 flex-col border-l border-border/70 bg-background max-[900px]:hidden">
      <div className="border-b border-border/60 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Rocket className="h-4 w-4 text-primary" />
          Crew
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {working.length} on duty
          {helpers > 0 && ` · ${helpers} helper ${helpers === 1 ? "robot" : "robots"}`}
          {reporting.length > 0 && ` · ${reporting.length} waiting on you`}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {members.length === 0 && offDuty === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No agents aboard yet.</p>
        )}
        {groups.filter((group) => group.members.length > 0).map((group) => (
          <section key={group.title} className="mb-3">
            <h3 className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">{group.title}</h3>
            <ul>
              {group.members.map((member) => (
                <li key={member.id}>
                  <ManifestRow member={member} highlighted={highlighted === member.id} onHover={onHover} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        {offDuty > 0 && (
          <p className="flex items-center gap-1.5 px-2 text-[11px] text-muted-foreground">
            <Coffee className="h-3 w-3" />
            {offDuty} more off duty
          </p>
        )}
      </div>
    </aside>
  );
}

function ManifestRow({ member, highlighted, onHover, onSelect }: {
  member: CrewMember;
  highlighted: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const where = member.mode === "resting" ? "Off duty" : `${member.task} · ${STATION_NAMES[member.station]}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(member.id)}
      onPointerEnter={() => onHover(member.id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onHover(member.id)}
      onBlur={() => onHover(null)}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150",
        highlighted ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      <svg viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 shrink-0" aria-hidden>
        <path d="M10 2.5C12.6 6.6 16.5 9.6 16.5 13.6c0 2.6-2.9 4.2-6.5 4.2s-6.5-1.6-6.5-4.2C3.5 9.6 7.4 6.6 10 2.5Z" fill={CREW_COLORS[member.colorIndex]} fillOpacity="0.9" />
        <rect x="7.3" y="10.4" width="1.6" height="2.8" rx="0.8" fill="#191a1b" />
        <rect x="11.1" y="10.4" width="1.6" height="2.8" rx="0.8" fill="#191a1b" />
      </svg>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{member.title}</span>
        <span className={cn(
          "block truncate text-[11px]",
          member.mode === "reporting" ? "text-amber-600 dark:text-amber-400"
            : member.mode === "fault" ? "text-red-600 dark:text-red-400"
              : "text-muted-foreground",
        )}>
          {where}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-muted-foreground">
        {member.risk !== "low" && (
          <ShieldAlert
            className={cn("h-3.5 w-3.5", member.risk === "high" ? "text-amber-600 dark:text-amber-400" : "")}
            aria-label={`${member.risk === "high" ? "High" : "Medium"} risk`}
          />
        )}
        {member.helpers > 0 && (
          <span className="flex items-center gap-0.5 text-[11px]" aria-label={`${member.helpers} active ${member.helpers === 1 ? "subagent" : "subagents"}`}>
            <Bot className="h-3.5 w-3.5" />{member.helpers}
          </span>
        )}
      </span>
    </button>
  );
}

export default FlightdeckView;
