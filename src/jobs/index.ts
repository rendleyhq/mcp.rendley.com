import type { CreateJobInput, Job, JobStore } from "@/types/jobs.types";
import { JobStatus } from "@/types/jobs.types";
import { createMemoryJobStore } from "@/jobs/memory-store";
import { dispatchJobWebhook } from "@/webhooks/deliver";

// In-memory only (single replica). Jobs don't survive a restart; shutdown
// marks every still-running job failed so pollers get a terminal answer.
const store: JobStore = createMemoryJobStore({
  onTerminal: dispatchJobWebhook,
});

export function createJob(input: CreateJobInput): Promise<Job> {
  return store.create(input);
}

export function getJob(id: string): Promise<Job | null> {
  return store.get(id);
}

export function updateJob(id: string, patch: Partial<Job>): Promise<Job | null> {
  return store.update(id, patch);
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
  const { owner_key_id, user_id, webhook_url, ...safe } = job;
  return safe;
}
