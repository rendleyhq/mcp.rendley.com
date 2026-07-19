import { createHmac } from "crypto";
import { config } from "@/config";
import { log } from "@/logger";
import type { Job } from "@/types/jobs.types";

const TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1000, 4000];
const DRAIN_TIMEOUT_MS = 20_000;

export interface JobWebhookPayload {
  job_id: string;
  kind: string;
  status: string;
  project_id: string;
  thread_id?: string;
  result?: unknown;
  error?: string;
  created_at: string;
  updated_at: string;
}

// Per-user key derived from the master secret. api.rendley.com derives the same
// value and serves it from GET /v1/webhooks/secret, so one secret verifies
// deliveries from both hosts — changing this breaks every existing consumer.
export function deriveSigningKey(userId: string): string {
  return createHmac("sha256", config.webhookSigningSecret)
    .update(`rendley-webhook:v1:${userId}`)
    .digest("hex");
}

export function signWebhookBody(
  userId: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  const signature = createHmac("sha256", deriveSigningKey(userId))
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

export function toWebhookPayload(job: Job): JobWebhookPayload {
  return {
    job_id: job.job_id,
    kind: job.kind,
    status: job.status,
    project_id: job.project_id,
    ...(job.thread_id ? { thread_id: job.thread_id } : {}),
    ...(job.result !== undefined ? { result: job.result } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    created_at: new Date(job.created_at).toISOString(),
    updated_at: new Date(job.updated_at).toISOString(),
  };
}

async function attemptDelivery(
  url: string,
  userId: string,
  rawBody: string,
  jobId: string,
): Promise<boolean> {
  const timestamp = Math.floor(Date.now() / 1000);
  // redirect: "error" is load-bearing. Following redirects lets a valid public
  // https endpoint answer 307 and have the signed body re-POSTed to an internal
  // address, which defeats the URL guard entirely.
  const res = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Rendley-Webhook/1",
      "X-Rendley-Event": "job.updated",
      "X-Rendley-Job-Id": jobId,
      "X-Rendley-Signature": signWebhookBody(userId, timestamp, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  await res.text().catch(() => "");
  return res.ok;
}

async function deliver(
  url: string,
  userId: string,
  rawBody: string,
  jobId: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (await attemptDelivery(url, userId, rawBody, jobId)) {
        log.info("job_webhook_delivered", { jobId, attempt });
        return;
      }
      log.warn("job_webhook_rejected", { jobId, attempt });
    } catch (err) {
      log.warn("job_webhook_attempt_failed", { jobId, attempt, err });
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) {
      log.error("job_webhook_gave_up", { jobId, attempts: attempt + 1 });
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delay).unref?.();
    });
  }
}

const inFlight = new Set<Promise<void>>();

// Fire-and-forget: never awaited by the caller, so it must not be able to
// reject. The body is serialized up front — a job evicted mid-delivery is fine.
export function dispatchJobWebhook(job: Job): void {
  if (!job.webhook_url || !config.webhookSigningSecret) return;

  const rawBody = JSON.stringify(toWebhookPayload(job));
  const promise = deliver(job.webhook_url, job.user_id, rawBody, job.job_id)
    .catch((err) => {
      log.error("job_webhook_dispatch_error", { jobId: job.job_id, err });
    })
    .finally(() => {
      inFlight.delete(promise);
    });
  inFlight.add(promise);
}

export async function drainJobWebhooks(
  maxWaitMs = DRAIN_TIMEOUT_MS,
): Promise<{ drained: number; abandoned: number }> {
  const pending = [...inFlight];
  if (pending.length === 0) return { drained: 0, abandoned: 0 };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.all(pending).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), maxWaitMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);

  // Only the ones we waited on count — a delivery dispatched mid-drain isn't ours.
  const abandoned = timedOut ? pending.filter((p) => inFlight.has(p)).length : 0;
  return { drained: pending.length - abandoned, abandoned };
}
