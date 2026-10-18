import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export function monitorServerPerformance(intervalMs = 30_000): () => void {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let previous = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const current = performance.eventLoopUtilization();
    const utilization = performance.eventLoopUtilization(current, previous);
    previous = current;
    console.info("[performance]", JSON.stringify({
      metric: "server.runtime",
      eventLoopMaxMs: delay.max / 1e6,
      eventLoopP99Ms: delay.percentile(99) / 1e6,
      eventLoopUtilization: utilization.utilization,
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      uptimeSeconds: process.uptime(),
    }));
    delay.reset();
  }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); delay.disable(); };
}
