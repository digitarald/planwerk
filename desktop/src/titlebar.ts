export const titlebarPreload = `
window.__PLANWERK_DESKTOP__ = true;
(() => {
  let dragging = false;
  const send = (action) => window.__electrobunSendToHost({ type: "titlebar", action });
  document.addEventListener("mousedown", (event) => {
    if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) return;
    if (!event.target.closest("[data-desktop-titlebar]")) return;
    if (event.target.closest("button, a, input, select, textarea, [role=button], [role=tab], [contenteditable], [data-no-drag]")) return;
    dragging = true;
    send("start");
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    send("stop");
  };
  document.addEventListener("mouseup", stop);
  window.addEventListener("blur", stop);
})();
`;

export function titlebarZoom(percent: number): string {
  return `(() => {
  const apply = () => {
    document.documentElement.style.setProperty("--desktop-traffic-inset", "${88 * 100 / percent}px");
    document.documentElement.style.setProperty("--desktop-header-min-height", "${44 * 100 / percent}px");
  };
  if (document.documentElement) apply();
  else document.addEventListener("DOMContentLoaded", apply, { once: true });
})();`;
}

export function titlebarAction(detail: unknown): "start" | "stop" | null {
  if (!detail || typeof detail !== "object" || !("type" in detail)
    || detail.type !== "titlebar" || !("action" in detail)) return null;
  return detail.action === "start" || detail.action === "stop" ? detail.action : null;
}
