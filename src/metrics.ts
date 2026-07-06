import { metrics } from "@opentelemetry/api";
import { getQueueStats } from "@/queue";

const meter = metrics.getMeter("rendley-mcp");

const running = meter.createObservableGauge("mcp.queue.running", {
  description: "Agent runs currently executing (browser slots in use).",
});
const queued = meter.createObservableGauge("mcp.queue.queued", {
  description: "Agent runs waiting for a browser slot.",
});
running.addCallback((r) => r.observe(getQueueStats().running));
queued.addCallback((r) => r.observe(getQueueStats().queued));

const queueFullRejectedCounter = meter.createCounter("mcp.queue.full_rejected", {
  description: "Edits rejected because the global pending cap (2000) was reached.",
});
const planResolveFailedCounter = meter.createCounter("mcp.plan_resolve.failed", {
  description: "Plan lookups (/users/me) that failed and fell back to the fail-open default (assume paid, fallback concurrency cap).",
});

export function recordQueueFullRejected(): void {
  queueFullRejectedCounter.add(1);
}
export function recordPlanResolveFailed(): void {
  planResolveFailedCounter.add(1);
}
