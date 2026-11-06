import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Preferences {
  zoom: number;
  normalFrame?: Frame;
}

interface Display {
  workArea: Frame;
  isPrimary: boolean;
}

export function isFrame(value: unknown): value is Frame {
  return Boolean(value && typeof value === "object"
    && "x" in value && typeof value.x === "number" && Number.isFinite(value.x)
    && "y" in value && typeof value.y === "number" && Number.isFinite(value.y)
    && "width" in value && typeof value.width === "number" && Number.isFinite(value.width) && value.width > 0
    && "height" in value && typeof value.height === "number" && Number.isFinite(value.height) && value.height > 0);
}

export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object"
    || !("zoom" in value) || typeof value.zoom !== "number"
    || !Number.isInteger(value.zoom) || value.zoom < 50 || value.zoom > 200 || value.zoom % 10 !== 0
    || ("normalFrame" in value && !isFrame(value.normalFrame))) {
    throw new Error("Invalid desktop preferences");
  }
  const normalFrame = "normalFrame" in value ? value.normalFrame : undefined;
  return { zoom: value.zoom, ...(isFrame(normalFrame) ? { normalFrame } : {}) };
}

export function restoreFrame(saved: Frame | undefined, displays: Display[]): Frame {
  const available = displays.filter((display) => isFrame(display.workArea));
  if (available.length === 0) throw new Error("No usable display work areas; using a centered window");
  const overlap = (area: Frame) => saved
    ? Math.max(0, Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x))
      * Math.max(0, Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y))
    : 0;
  const best = available.reduce((a, b) => overlap(b.workArea) > overlap(a.workArea) ? b : a);
  const area = (overlap(best.workArea) > 0 ? best : available.find((d) => d.isPrimary) ?? available[0]).workArea;
  const width = Math.min(saved?.width ?? 1280, area.width);
  const height = Math.min(saved?.height ?? 840, area.height);
  return {
    x: Math.max(area.x, Math.min(saved?.x ?? area.x + (area.width - width) / 2, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(saved?.y ?? area.y + (area.height - height) / 2, area.y + area.height - height)),
    width, height,
  };
}

export class DesktopPreferences {
  value: Preferences = { zoom: 100 };
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly path: string;
  private readonly report: (operation: "read" | "save", error: unknown) => void;

  constructor(
    path: string,
    report: (operation: "read" | "save", error: unknown) => void,
  ) {
    this.path = path;
    this.report = report;
    try {
      this.value = parsePreferences(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        report("read", error);
      }
    }
  }

  update(value: Preferences): void {
    const next = parsePreferences(value);
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.value = next;
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush(): void {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.value) + "\n", { mode: 0o600 });
      renameSync(temporary, this.path);
      this.dirty = false;
    } catch (error) {
      this.report("save", error);
      try {
        rmSync(temporary, { force: true });
      } catch (cleanupError) {
        this.report("save", cleanupError);
      }
    }
  }
}
