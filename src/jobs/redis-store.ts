import { randomUUID } from "crypto";
import { RedisClient } from "bun";
import { log } from "@/logger";
import type { CreateJobInput, Job, JobStore } from "@/types/jobs.types";
import { JobStatus } from "@/types/jobs.types";
import { createMemoryJobStore, isTerminal, ORPHAN_MAX_AGE_MS } from "@/jobs/memory-store";

// Terminal jobs live long enough for slow-polling clients to fetch results;
// non-terminal jobs expire shortly after the orphan window so a dead replica's
// keys don't accumulate.
const TERMINAL_TTL_SEC = 24 * 60 * 60;
const RUNNING_TTL_SEC = Math.ceil(ORPHAN_MAX_AGE_MS / 1000) + 60 * 60;

const KEY_PREFIX = "mcp:job:";

// Durable job store on Redis with a write-through in-memory mirror. Reads
// prefer Redis (cross-replica, survives restarts); when Redis is unavailable
// the mirror keeps the current replica's jobs working, loudly logged.
export function createRedisJobStore(url: string): JobStore {
  const client = new RedisClient(url);
  const mirror = createMemoryJobStore();
  const logger = log.child({ component: "redisJobStore" });

  const persist = async (job: Job): Promise<void> => {
    const ttl = isTerminal(job.status) ? TERMINAL_TTL_SEC : RUNNING_TTL_SEC;
    await client.send("SET", [
      `${KEY_PREFIX}${job.job_id}`,
      JSON.stringify(job),
      "EX",
      String(ttl),
    ]);
  };

  const readRedis = async (id: string): Promise<Job | null> => {
    const raw = await client.get(`${KEY_PREFIX}${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as Job;
  };

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
      // Mirror first so the job exists locally even if the Redis write fails.
      await mirror.insert(job);
      try {
        await persist(job);
      } catch (err) {
        logger.error("redis_write_failed_create", { jobId: job.job_id, err });
      }
      return job;
    },

    async insert(job: Job): Promise<void> {
      await mirror.insert(job);
      try {
        await persist(job);
      } catch (err) {
        logger.error("redis_write_failed_insert", { jobId: job.job_id, err });
      }
    },

    async get(id: string): Promise<Job | null> {
      let job: Job | null = null;
      let redisAvailable = true;
      try {
        job = await readRedis(id);
      } catch (err) {
        redisAvailable = false;
        logger.error("redis_read_failed", { jobId: id, err });
      }
      if (!job) {
        // Redis miss/outage — the mirror covers jobs created on this replica.
        return mirror.get(id);
      }

      // Orphan-on-read: a job stuck non-terminal past the orphan window means
      // its runner died (crash, restart) — surface a terminal failure.
      if (!isTerminal(job.status) && Date.now() - job.updated_at > ORPHAN_MAX_AGE_MS) {
        const failed: Job = {
          ...job,
          status: JobStatus.Failed,
          error: "orphaned",
          result: { reason: "orphaned" },
          updated_at: Date.now(),
        };
        if (redisAvailable) {
          await persist(failed).catch((err) =>
            logger.error("redis_write_failed_orphan", { jobId: id, err }),
          );
        }
        return failed;
      }
      return job;
    },

    async update(id: string, patch: Partial<Job>): Promise<Job | null> {
      const existing = await this.get(id);
      if (!existing) return null;
      const updated: Job = { ...existing, ...patch, updated_at: Date.now() };
      await mirror.insert(updated);
      try {
        await persist(updated);
      } catch (err) {
        logger.error("redis_write_failed_update", { jobId: id, err });
      }
      return updated;
    },
  };
}
