import type { CreateJobInput, Job, JobStore } from "@/types/jobs.types";
import { JobStatus } from "@/types/jobs.types";
import { createMemoryJobStore } from "@/jobs/memory-store";

// In-memory only (single replica). Jobs don't survive a restart; shutdown
// marks every still-running job failed so pollers get a terminal answer.
const store: JobStore = createMemoryJobStore();

export function createJob(input: CreateJobInput): Promise<Job> {
  return store.create(input);
}

export function getJob(id: string): Promise<Job | null> {
  return store.get(id);
}

export function updateJob(id: string, patch: Partial<Job>): Promise<Job | null> {
  return store.update(id, patch);
}

const TERMINAL_STATUSES = new Set([JobStatus.Completed, JobStatus.Failed, JobStatus.Cancelled]);

export function isJobTerminal(job: Job): boolean {
  return TERMINAL_STATUSES.has(job.status);
}

// Long-poll: resolves as soon as the job reaches a terminal status, or with the
// latest snapshot once timeoutMs elapses. Holding the request server-side keeps
// LLM clients from burning their per-turn tool-call budget on instant
// in_progress polls. Cheap: the store is in-memory (single replica).
export async function waitForJob(id: string, timeoutMs: number, intervalMs = 500): Promise<Job | null> {
  const deadline = Date.now() + timeoutMs;
  let job = await store.get(id);
  while (job && !isJobTerminal(job)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
    job = await store.get(id);
  }
  return job;
}

// Fail every job still running on this replica so pollers get a terminal
// answer. Called during shutdown after the drain window, so only jobs that
// genuinely didn't finish in time are marked. Returns how many were failed.
export async function failInterruptedJobs(): Promise<number> {
  const running = await store.listNonTerminal();
  await Promise.all(
    running.map((job) =>
      store
        .update(job.job_id, {
          status: JobStatus.Failed,
          error: "server restarting — the edit was interrupted",
          result: { reason: "server_restarting", retryable: true },
        })
        .catch(() => null),
    ),
  );
  return running.length;
}

export function jobToResponse(job: Job): Record<string, unknown> {
  const { owner_key_id, ...safe } = job;
  return safe;
}
