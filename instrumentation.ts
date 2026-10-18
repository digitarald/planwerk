import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.PLANWERK_DESKTOP_TOKEN) {
    const { monitorServerPerformance } = await import("./lib/diagnostics/server-performance");
    monitorServerPerformance();
  }
}

export const onRequestError: Instrumentation.onRequestError = (error, _request, context) => {
  console.error("[server:request]", {
    route: context.routePath,
    type: context.routeType,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
};
