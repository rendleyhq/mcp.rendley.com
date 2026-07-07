import PQueue from "p-queue";
import { config } from "@/config";

// Concurrency here is the browser-spawn limit: at most this many agent runs
// launch a browser at once. Everything else waits in the queue.
export const jobQueue = new PQueue({ concurrency: config.queueConcurrency });

// Global admission cap (config.queueMaxQueued): total edits in flight across all
// tenants — waiting for a run slot, queued, or running. This is the ONLY hard
// rejection. Per-tenant caps make a request wait for a slot rather than turning
// it away, so a request is only refused when the whole server is this deep in
// pending work.
let pendingTasks = 0;

// Reserve a global slot for one edit. Returns false when at capacity (the caller
// must reject). Pair every successful reserve with exactly one releaseTask.
export function tryReserveTask(): boolean {
  if (pendingTasks >= config.queueMaxQueued) return false;
  pendingTasks += 1;
  return true;
}

export function releaseTask(): void {
  if (pendingTasks > 0) pendingTasks -= 1;
}

export function getQueueStats() {
  return {
    concurrency: config.queueConcurrency,
    running: jobQueue.pending,
    queued: jobQueue.size,
    pending: pendingTasks,
    maxPending: config.queueMaxQueued,
  };
}

export async function runQueued<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const result = await jobQueue.add(task, signal ? { signal } : undefined);
  return result as T;
}
