import { acquireAllOrWait, SLOT_WAIT_TIMEOUT_MS, type SlotRequest } from "@/concurrency-limits";
import { registerJobAbort, unregisterJobAbort } from "@/jobs/cancellation";
import { createJob, getJob, isJobTerminal, updateJob } from "@/jobs/index";
import { log } from "@/logger";
import { recordQueueFullRejected } from "@/metrics";
import { runQueued, tryReserveTask, releaseTask } from "@/queue";
import type { CreateJobInput, Job } from "@/types/jobs.types";
import { JobStatus } from "@/types/jobs.types";

// Thrown when the global pending cap rejects the launch — the only hard
// rejection in the system; everything else waits for a slot.
export class QueueFullError extends Error {
  constructor() {
    super("The editor has a lot of work queued right now. Please retry in a few seconds.");
    this.name = "QueueFullError";
  }
}

export interface LaunchQueuedJobInput {
  // Runs after the pending-slot reservation (so queue-full rejects before any
  // API work) and produces the job record + the run-slot requirements. A throw
  // here releases the reservation and propagates to the caller.
  prepare: () => Promise<{ job: CreateJobInput; slots: SlotRequest[] }>;
  // Register an abort handle so cancel_edit can stop the run (agent jobs).
  cancellable?: boolean;
  // Does the actual work and owns the job's terminal status; the launcher
  // records the failure modes around it (slot timeout, enqueue crash) and
  // ignores the return value.
  run: (job: Job, signal?: AbortSignal) => Promise<unknown>;
}

// The single way a background job enters the system — shared by edit_video and
// every motion-graphics mutation: reserve against the global pending cap,
// create the job record, then in the background wait for the per-tenant /
// per-project run slots, run through the browser queue, and release
// everything. Returns the job immediately; callers poll it via check_edit.
export async function launchQueuedJob(input: LaunchQueuedJobInput): Promise<Job> {
  if (!tryReserveTask()) {
    recordQueueFullRejected();
    throw new QueueFullError();
  }
  let reserved = true;
  const releaseReserved = () => {
    if (reserved) {
      reserved = false;
      releaseTask();
    }
  };

  try {
    const { job: jobInput, slots: slotReqs } = await input.prepare();
    const job = await createJob(jobInput);
    const logger = log.child({
      jobId: job.job_id,
      projectId: jobInput.project_id,
      component: "jobLauncher",
    });
    const abort = input.cancellable ? registerJobAbort(job.job_id) : null;
    const cleanupAbort = () => {
      if (abort) {
        unregisterJobAbort(job.job_id);
      }
    };

    // Fire-and-forget: wait for a run slot (so a batch queues instead of being
    // rejected), run, then release everything.
    void (async () => {
      const slots = await acquireAllOrWait(slotReqs, {
        ...(abort ? { signal: abort.signal } : {}),
        timeoutMs: SLOT_WAIT_TIMEOUT_MS,
      });
      if (!slots) {
        // Aborted → the cancel path already set the terminal status. Timed out
        // waiting → record it so the poller gets a definite answer.
        if (!abort?.signal.aborted) {
          await updateJob(job.job_id, {
            status: JobStatus.Failed,
            error: "No editor slot became available in time.",
            result: { reason: "slot_wait_timeout" },
          }).catch(() => null);
        }
        cleanupAbort();
        releaseReserved();
        return;
      }
      // A long slot wait can outlive the store's orphan threshold (or a cancel):
      // once a poller has been told the job is terminal, running it anyway would
      // resurrect a "failed" job and confuse the client. Skip instead.
      const current = await getJob(job.job_id).catch(() => null);
      if (!current || isJobTerminal(current)) {
        logger.warn("job_terminal_before_run_skipped", { status: current?.status ?? "missing" });
        await slots.release();
        cleanupAbort();
        releaseReserved();
        return;
      }
      try {
        await runQueued(() => input.run(job, abort?.signal));
      } catch (err) {
        logger.error("job_run_failed", { err });
        await updateJob(job.job_id, {
          status: JobStatus.Failed,
          error: err instanceof Error ? err.message : String(err),
          result: { reason: "enqueue_failed" },
        }).catch(() => null);
      } finally {
        await slots.release();
        cleanupAbort();
        releaseReserved();
      }
    })();

    return job;
  } catch (err) {
    releaseReserved();
    throw err;
  }
}
