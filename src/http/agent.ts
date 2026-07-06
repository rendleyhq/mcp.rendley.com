import { z } from "zod";
import type { ApiClient } from "@/api/client";
import { runAgentJob } from "@/agent-runner";
import type { BridgeAttachment } from "@/types/bridge.types";
import { createJob, jobToResponse, updateJob } from "@/jobs/index";
import { registerJobAbort, unregisterJobAbort } from "@/jobs/cancellation";
import { JobKind, JobStatus } from "@/types/jobs.types";
import { log } from "@/logger";
import { getQueueStats, isQueueFull, runQueued } from "@/queue";
import { validateExternalUrl, UrlGuardError } from "@/utils/url-guard";
import {
  acquireAll,
  resolveKeys,
  MAX_CONCURRENT_PER_END_USER,
} from "@/concurrency-limits";
import { resolveMcpMaxConcurrent } from "@/plan-cache";
import { recordConcurrencyRejected, recordQueueFullRejected } from "@/metrics";

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

const CONCURRENCY_RETRY_AFTER_SECONDS = 10;

function concurrencyRejected(message: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "CONCURRENCY_LIMIT",
        message,
        retryAfterSeconds: CONCURRENCY_RETRY_AFTER_SECONDS,
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(CONCURRENCY_RETRY_AFTER_SECONDS),
      },
    },
  );
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

  if (isQueueFull()) {
    const stats = getQueueStats();
    recordQueueFullRejected();
    log.warn("queue_saturated_agent_rejected", stats);
    return new Response(
      JSON.stringify({
        error: {
          code: "QUEUE_FULL",
          message: "MCP server is at capacity. Retry shortly.",
          stats,
        },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "10",
        },
      },
    );
  }

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

  // Fairness gate: the backend owns the plan's concurrent-edit cap
  // (GET /agent/limits); we only count in-flight edits against it, so one
  // user can't occupy every browser. The queue caps the global total.
  const maxConcurrent = await resolveMcpMaxConcurrent(deps.userId, deps.apiClient);
  const { tenantKey, endUserKey } = resolveKeys(deps.userId, endUserId);
  const reqs = [{ key: tenantKey, max: maxConcurrent }];
  if (endUserKey !== tenantKey) {
    reqs.push({ key: endUserKey, max: MAX_CONCURRENT_PER_END_USER });
  }
  const acquired = await acquireAll(reqs);
  if (!acquired) {
    recordConcurrencyRejected();
    log.warn("concurrency_limit_exceeded", { endUserId });
    return concurrencyRejected(
      "Too many concurrent edits right now. Retry shortly.",
    );
  }

  const releaseSlots = () => acquired.release();

  const queryThreadId = new URL(req.url).searchParams.get("thread_id");
  const threadId = body.thread_id ?? queryThreadId ?? undefined;
  if (threadId && !ID_RE.test(threadId)) {
    releaseSlots();
    return badRequest("BAD_REQUEST", "thread_id must match /^[A-Za-z0-9_-]{1,128}$/");
  }

  const hasProjectId = Boolean(body.project_id && body.project_id.trim() !== "");
  if (threadId && !hasProjectId) {
    releaseSlots();
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
    releaseSlots();
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
      releaseSlots();
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
    void runQueued(async () =>
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
    )
      .catch(async (err) => {
        log.error("rest_agent_enqueue_failed", { jobId: job.job_id, err });
        await updateJob(job.job_id, {
          status: JobStatus.Failed,
          error: err instanceof Error ? err.message : String(err),
          result: { reason: "enqueue_failed" },
        }).catch(() => {});
      })
      .finally(() => {
        unregisterJobAbort(job.job_id);
        return releaseSlots();
      });
  } catch (err) {
    releaseSlots();
    return json(500, {
      error: {
        code: "JOB_CREATE_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }

  return json(202, { ...jobToResponse(job), thread_id: resolvedThreadId });
}
