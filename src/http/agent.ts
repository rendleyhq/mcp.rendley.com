import { z } from "zod";
import type { ApiClient } from "@/api/client";
import { runAgentJob } from "@/agent-runner";
import type { BridgeAttachment } from "@/types/bridge.types";
import { createJob, jobToResponse, updateJob } from "@/jobs/index";
import { registerJobAbort, unregisterJobAbort } from "@/jobs/cancellation";
import { JobKind, JobStatus } from "@/types/jobs.types";
import { log } from "@/logger";
import { getQueueStats, runQueued, tryReserveTask, releaseTask } from "@/queue";
import { validateExternalUrl, UrlGuardError } from "@/utils/url-guard";
import {
  acquireAllOrWait,
  resolveKeys,
  MAX_CONCURRENT_PER_END_USER,
  SLOT_WAIT_TIMEOUT_MS,
} from "@/concurrency-limits";
import { resolveMcpMaxConcurrent } from "@/plan";
import { recordQueueFullRejected } from "@/metrics";

interface Deps {
  apiClient: ApiClient;
  apiKey: string;
  apiKeyId: string;
  userId: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PROMPT_CHARS = 20_000;
const MAX_FILES_PER_REQUEST = 100;

const FileSchema = z.object({
  url: z.string().url().max(2048).optional(),
  storage_url: z.string().url().max(2048).optional(),
  media_id: z
    .string()
    .regex(ID_RE, "media_id must match /^[A-Za-z0-9_-]{1,128}$/")
    .optional(),
  name: z.string().max(256).optional(),
}).refine((value) => Boolean(value.url || value.storage_url || value.media_id), {
  message: "at least one of url, storage_url, or media_id is required",
});

const StartBodySchema = z.object({
  prompt: z.string().min(1, "prompt is required").max(MAX_PROMPT_CHARS),
  project_id: z
    .string()
    .regex(ID_RE, "project_id must match /^[A-Za-z0-9_-]{1,128}$/")
    .optional(),
  thread_id: z
    .string()
    .regex(ID_RE, "thread_id must match /^[A-Za-z0-9_-]{1,128}$/")
    .optional(),
  end_user_id: z
    .string()
    .regex(ID_RE, "end_user_id must match /^[A-Za-z0-9_-]{1,128}$/")
    .optional(),
  files: z.array(FileSchema).max(MAX_FILES_PER_REQUEST).optional().default([]),
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function badRequest(code: string, message: string): Response {
  return json(400, { error: { code, message } });
}

function deriveAttachmentName(input: { url?: string; storage_url?: string; name?: string }): string | undefined {
  if (input.name?.trim()) return input.name.trim();

  const rawUrl = input.storage_url ?? input.url;
  if (!rawUrl) return undefined;

  try {
    const parsed = new URL(rawUrl);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) return decodeURIComponent(lastSegment);
  } catch {
  }

  return rawUrl.split("/").pop()?.split("?")[0] || undefined;
}

export async function handleStartAgentJob(
  req: Request,
  deps: Deps,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("BAD_REQUEST", "expected application/json body");
  }

  const parsed = StartBodySchema.safeParse(raw);
  if (!parsed.success) {
    return badRequest(
      "BAD_REQUEST",
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  }
  const body = parsed.data;

  for (const f of body.files) {
    for (const u of [f.url, f.storage_url]) {
      if (!u) continue;
      try {
        validateExternalUrl(u);
      } catch (err) {
        if (err instanceof UrlGuardError) {
          return badRequest("BLOCKED_URL", `file url rejected: ${err.message}`);
        }
        throw err;
      }
    }
  }

  const headerEndUserId = req.headers.get("x-end-user-id")?.trim() || undefined;
  const endUserId = body.end_user_id ?? headerEndUserId;
  if (endUserId && !ID_RE.test(endUserId)) {
    return badRequest(
      "BAD_REQUEST",
      "end_user_id must match /^[A-Za-z0-9_-]{1,128}$/",
    );
  }

  // The only hard rejection is the global pending cap; the plan's per-tenant cap
  // makes a request wait for a run slot (in the background below), not fail.
  if (!tryReserveTask()) {
    recordQueueFullRejected();
    log.warn("pending_cap_reached_agent_rejected", getQueueStats());
    return new Response(
      JSON.stringify({
        error: {
          code: "QUEUE_FULL",
          message: "The server has a lot of edits queued. Retry shortly.",
          stats: getQueueStats(),
        },
      }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "10" },
      },
    );
  }
  let reserved = true;
  const releaseReserved = () => {
    if (reserved) {
      reserved = false;
      releaseTask();
    }
  };
  const maxConcurrent = await resolveMcpMaxConcurrent(deps.apiClient);
  const { tenantKey, endUserKey } = resolveKeys(deps.userId, endUserId);

  const queryThreadId = new URL(req.url).searchParams.get("thread_id");
  const threadId = body.thread_id ?? queryThreadId ?? undefined;
  if (threadId && !ID_RE.test(threadId)) {
    releaseReserved();
    return badRequest("BAD_REQUEST", "thread_id must match /^[A-Za-z0-9_-]{1,128}$/");
  }

  const hasProjectId = Boolean(body.project_id && body.project_id.trim() !== "");
  if (threadId && !hasProjectId) {
    releaseReserved();
    return badRequest(
      "BAD_REQUEST",
      "project_id is required when thread_id is provided",
    );
  }

  let projectId: string;
  try {
    projectId = await deps.apiClient.resolveOrCreateProject(body.project_id, {
      prompt: body.prompt,
    });
  } catch (err) {
    releaseReserved();
    return badRequest(
      "PROJECT_CREATE_FAILED",
      err instanceof Error ? err.message : String(err),
    );
  }

  let resolvedThreadId: string;
  if (threadId) {
    resolvedThreadId = threadId;
  } else {
    try {
      resolvedThreadId = await deps.apiClient.createAgentThread(projectId);
    } catch (err) {
      releaseReserved();
      return badRequest(
        "THREAD_CREATE_FAILED",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  let job: Awaited<ReturnType<typeof createJob>>;
  try {
    job = await createJob({
      kind: JobKind.Agent,
      project_id: projectId,
      owner_key_id: deps.apiKeyId,
      thread_id: resolvedThreadId,
    });

    log.info("rest_agent_job_started", {
      jobId: job.job_id,
      projectId,
      threadId: resolvedThreadId,
      files: body.files.length,
    });

    const attachments: BridgeAttachment[] = body.files.map((f) => {
      const name = deriveAttachmentName(f);
      return {
        ...(f.storage_url || f.url ? { storage_url: f.storage_url ?? f.url } : {}),
        ...(f.media_id ? { media_id: f.media_id } : {}),
        ...(name ? { name } : {}),
      };
    });

    const abort = registerJobAbort(job.job_id);

    // Wait for a run slot (plan cap + one-edit-per-project), run, then release.
    // Fire-and-forget: the endpoint returns 202 with the job_id now, and the
    // caller polls GET /v1/agent/jobs/:id until the job reaches a terminal state.
    const runReqs = [
      { key: tenantKey, max: maxConcurrent },
      { key: `project:${projectId}`, max: 1 },
    ];
    if (endUserKey !== tenantKey) {
      runReqs.push({ key: endUserKey, max: MAX_CONCURRENT_PER_END_USER });
    }
    void (async () => {
      const slots = await acquireAllOrWait(runReqs, {
        signal: abort.signal,
        timeoutMs: SLOT_WAIT_TIMEOUT_MS,
      });
      if (!slots) {
        if (!abort.signal.aborted) {
          await updateJob(job.job_id, {
            status: JobStatus.Failed,
            error: "No editor slot became available in time.",
            result: { reason: "slot_wait_timeout" },
          }).catch(() => {});
        }
        unregisterJobAbort(job.job_id);
        releaseReserved();
        return;
      }
      try {
        await runQueued(() =>
          runAgentJob({
            jobId: job.job_id,
            apiKey: deps.apiKey,
            apiKeyId: deps.apiKeyId,
            projectId,
            prompt: body.prompt,
            attachments,
            threadId: resolvedThreadId,
            signal: abort.signal,
          }),
        );
      } catch (err) {
        log.error("rest_agent_run_failed", { jobId: job.job_id, err });
        await updateJob(job.job_id, {
          status: JobStatus.Failed,
          error: err instanceof Error ? err.message : String(err),
          result: { reason: "enqueue_failed" },
        }).catch(() => {});
      } finally {
        await slots.release();
        unregisterJobAbort(job.job_id);
        releaseReserved();
      }
    })();
  } catch (err) {
    releaseReserved();
    return json(500, {
      error: {
        code: "JOB_CREATE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }

  return json(202, { ...jobToResponse(job), thread_id: resolvedThreadId });
}
