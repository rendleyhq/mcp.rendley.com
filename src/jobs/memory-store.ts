import { randomUUID } from "crypto";
import { config } from "@/config";
import { log } from "@/logger";
import type { CreateJobInput, Job, JobStore } from "@/types/jobs.types";
import { JobStatus } from "@/types/jobs.types";

export const JOB_TTL_MS = 60 * 60 * 1000;
export const ORPHAN_MAX_AGE_MS = config.agentTimeoutMs + 600_000;

export const isTerminal = (s: JobStatus) =>
  s === JobStatus.Completed || s === JobStatus.Failed || s === JobStatus.Cancelled;

// Terminal jobs are evicted lazily on read, but a completed job that's never
// polled again would linger — sweep the map periodically so it can't grow
// unbounded on a long-lived process.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface MemoryJobStoreOptions {
  // Fired once per job, on the first write that takes it terminal.
  onTerminal?: (job: Job) => void;
}

export function createMemoryJobStore(options: MemoryJobStoreOptions = {}): JobStore {
  const jobs = new Map<string, Job>();

  // Only a non-terminal -> terminal crossing fires, so a double terminal write
  // (cancel, then the runner's finally block) can't deliver twice.
  const emitTerminal = (before: Job | undefined, after: Job): void => {
    if (!options.onTerminal) return;
    if (before && isTerminal(before.status)) return;
    if (!isTerminal(after.status)) return;
    try {
      options.onTerminal(after);
    } catch (err) {
      log.error("job_terminal_listener_failed", { jobId: after.job_id, err });
    }
  };

  // Shared by the lazy read path and the sweep: webhook consumers don't poll, so
  // a runner that dies without a terminal write must still be reaped on a timer.
  const failOrphan = (job: Job): Job => {
    const failed: Job = {
      ...job,
      status: JobStatus.Failed,
      error: "orphaned",
      result: { reason: "orphaned" },
      updated_at: Date.now(),
    };
    jobs.set(job.job_id, failed);
    emitTerminal(job, failed);
    return failed;
  };

  const sweep = () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (isTerminal(job.status)) {
        if (now - job.updated_at > JOB_TTL_MS) jobs.delete(id);
      } else if (now - job.updated_at > ORPHAN_MAX_AGE_MS) {
        failOrphan(job);
      }
    }
  };
  setInterval(sweep, SWEEP_INTERVAL_MS).unref?.();

  return {
    async create(input: CreateJobInput): Promise<Job> {
      const now = Date.now();
      const job: Job = {
        job_id: randomUUID(),
        kind: input.kind,
        project_id: input.project_id,
        owner_key_id: input.owner_key_id,
        user_id: input.user_id,
        status: JobStatus.Pending,
        created_at: now,
        updated_at: now,
        ...(input.webhook_url ? { webhook_url: input.webhook_url } : {}),
        ...(input.thread_id ? { thread_id: input.thread_id } : {}),
      };
      jobs.set(job.job_id, job);
      return job;
    },

    async insert(job: Job): Promise<void> {
      const existing = jobs.get(job.job_id);
      jobs.set(job.job_id, job);
      emitTerminal(existing, job);
    },

    async get(id: string): Promise<Job | null> {
      const job = jobs.get(id);
      if (!job) return null;
      const age = Date.now() - job.updated_at;

      if (isTerminal(job.status)) {
        if (age > JOB_TTL_MS) {
          jobs.delete(id);
          return null;
        }
        return job;
      }

      if (age > ORPHAN_MAX_AGE_MS) {
        return failOrphan(job);
      }
      return job;
    },

    async update(id: string, patch: Partial<Job>): Promise<Job | null> {
      const existing = jobs.get(id);
      if (!existing) return null;
      const updated: Job = { ...existing, ...patch, updated_at: Date.now() };
      jobs.set(id, updated);
      emitTerminal(existing, updated);
      return updated;
    },

    async listNonTerminal(): Promise<Job[]> {
      const out: Job[] = [];
      for (const job of jobs.values()) {
        if (!isTerminal(job.status)) out.push(job);
      }
      return out;
    },
  };
}
