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

const concurrencyRejectedCounter = meter.createCounter(
  "mcp.concurrency.rejected",
  { description: "Requests rejected by the per-tenant/end-user concurrency cap." },
);
const queueFullRejectedCounter = meter.createCounter("mcp.queue.full_rejected", {
  description: "Requests rejected because the queue hit its DoS ceiling.",
});
const planDowngradeCounter = meter.createCounter("mcp.plan_cap.downgraded", {
  description: "Plan lookups (/users/me) that failed and fell back to the fail-open default (assume paid, fallback concurrency cap).",
});

export function recordConcurrencyRejected(): void {
  concurrencyRejectedCounter.add(1);
}
export function recordQueueFullRejected(): void {
  queueFullRejectedCounter.add(1);
}
export function recordPlanDowngrade(): void {
  planDowngradeCounter.add(1);
}
