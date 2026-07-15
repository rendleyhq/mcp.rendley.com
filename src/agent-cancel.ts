import { getJob, updateJob } from "@/jobs/index";
import { abortJob } from "@/jobs/cancellation";
import { isTerminal } from "@/jobs/memory-store";
import type { Job } from "@/types/jobs.types";
import { JobKind, JobStatus } from "@/types/jobs.types";

export type CancelOutcome =
  | { status: "not_found" }
  | { status: "not_cancellable"; job: Job }
  | { status: "already_done"; job: Job }
  | { status: "cancelled"; job: Job };

// Cancels an agent job the caller owns: aborts the in-flight browser run on
// this replica (if live here). Server-side session cancel is a future task —
// until then the API's own run timeout is the backstop. Idempotent — a
// terminal job is returned unchanged.
export async function cancelAgentJob(
  jobId: string,
  ownerKeyId: string,
): Promise<CancelOutcome> {
  const job = await getJob(jobId);
  if (!job || job.owner_key_id !== ownerKeyId) return { status: "not_found" };
  // Only agent jobs register an abort handle. Marking any other kind cancelled
  // would lie: its run keeps going and later overwrites the status anyway.
  if (job.kind !== JobKind.Agent) return { status: "not_cancellable", job };
  if (isTerminal(job.status)) return { status: "already_done", job };

  abortJob(jobId);

  const updated = await updateJob(jobId, {
    status: JobStatus.Cancelled,
    error: "cancelled by user",
    result: { reason: "cancelled", thread_id: job.thread_id ?? null },
  });
  return { status: "cancelled", job: updated ?? job };
}
