import { config } from "@/config";
import { log } from "@/logger";
import type { CreateJobInput, Job, JobStore } from "@/types/jobs.types";
import { createMemoryJobStore } from "@/jobs/memory-store";
import { createRedisJobStore } from "@/jobs/redis-store";

const store: JobStore = config.redisUrl
  ? createRedisJobStore(config.redisUrl)
  : createMemoryJobStore();

log.info("job_store_selected", {
  store: config.redisUrl ? "redis" : "memory",
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

export function jobToResponse(job: Job): Record<string, unknown> {
  const { owner_key_id, ...safe } = job;
  return safe;
}
