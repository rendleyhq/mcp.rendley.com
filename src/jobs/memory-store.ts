import { randomUUID } from "crypto";
import { config } from "@/config";
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

export function createMemoryJobStore(): JobStore {
  const jobs = new Map<string, Job>();

  const sweep = () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (isTerminal(job.status) && now - job.updated_at > JOB_TTL_MS) {
        jobs.delete(id);
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
        status: JobStatus.Pending,
        created_at: now,
        updated_at: now,
        ...(input.thread_id ? { thread_id: input.thread_id } : {}),
      };
      jobs.set(job.job_id, job);
      return job;
    },

    async insert(job: Job): Promise<void> {
      jobs.set(job.job_id, job);
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
        const failed: Job = {
          ...job,
          status: JobStatus.Failed,
          error: "The job made no progress for too long and was marked failed. Retry the operation.",
          result: { reason: "orphaned" },
          updated_at: Date.now(),
        };
        jobs.set(id, failed);
        return failed;
      }
      return job;
    },

    async update(id: string, patch: Partial<Job>): Promise<Job | null> {
      const existing = jobs.get(id);
      if (!existing) return null;
      const updated: Job = { ...existing, ...patch, updated_at: Date.now() };
      jobs.set(id, updated);
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
