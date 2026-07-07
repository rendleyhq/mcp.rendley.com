// In-process registry of abortable agent jobs. A controller is registered when
// a job is admitted (so a cancel lands even while the job waits in the queue)
// and removed when it settles. Single-instance today; if the deploy ever goes
// multi-replica, a job's controller only lives on the replica running it —
// route cancels there, or fall back to the API thread cancel.
const controllers = new Map<string, AbortController>();

export function registerJobAbort(jobId: string): AbortController {
  const controller = new AbortController();
  controllers.set(jobId, controller);
  return controller;
}

export function unregisterJobAbort(jobId: string): void {
  controllers.delete(jobId);
}

// Aborts the job's in-flight run if it's registered on this replica. Returns
// whether a controller was found (i.e. the job is live here).
export function abortJob(jobId: string): boolean {
  const controller = controllers.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}
