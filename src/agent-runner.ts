import { ApiClient } from "@/api/client";
import { config, headlessProjectUrl } from "@/config";
import { getAgentBrowser } from "@/sdk/browser-factory";
import { BrowserBusyError } from "@/sdk/remote-browser";
import { updateJob } from "@/jobs/index";
import { log } from "@/logger";
import type { BridgeAttachment } from "@/types/bridge.types";
import type { Job } from "@/types/jobs.types";
import { JobStatus } from "@/types/jobs.types";

const PROGRESS_RING_SIZE = 20;

interface RunInput {
  jobId: string;
  apiKey: string;
  apiKeyId: string;
  projectId: string;
  prompt: string;
  attachments: BridgeAttachment[];
  maxWaitMs?: number;
  threadId: string;
  // Live progress forwarding (e.g. MCP progress notifications during the
  // synchronous window). Progress is always persisted on the job regardless.
  onProgress?: (message: string) => void | Promise<void>;
  // Aborts the browser-worker run (user cancel / explicit cancel endpoint).
  signal?: AbortSignal;
}

// Runs the browser-mediated agent edit and writes the terminal state to the job
// store, then emits ONE wide completion event (status + duration) covering every
// exit path. Returns the final job record so synchronous callers (the hybrid
// edit_video window) can use the result without re-reading the store.
export async function runAgentJob(input: RunInput): Promise<Job | null> {
  const startedAt = Date.now();
  const job = await runAgentJobInner(input);
  const result = job?.result as { reason?: string } | undefined;
  log.info("agent job finished", {
    jobId: input.jobId,
    projectId: input.projectId,
    threadId: input.threadId,
    status: job?.status ?? "unknown",
    reason: result?.reason,
    duration_ms: Date.now() - startedAt,
  });
  return job;
}

async function runAgentJobInner(input: RunInput): Promise<Job | null> {
  const maxWaitMs = input.maxWaitMs ?? config.agentTimeoutMs;
  const logger = log.child({
    jobId: input.jobId,
    projectId: input.projectId,
    component: "agent_runner",
  });

  const progressRing: string[] = [];
  const progress = async (message: string): Promise<void> => {
    progressRing.push(message);
    if (progressRing.length > PROGRESS_RING_SIZE) progressRing.shift();
    await updateJob(input.jobId, {
      progress: [...progressRing],
      last_progress_at: Date.now(),
    }).catch(() => {});
    try {
      await input.onProgress?.(message);
    } catch {
      // progress forwarding is best-effort (client may have disconnected)
    }
  };

  // Marks the job cancelled. This only stops the browser-side run (via the
  // abort signal); server-side session cancel is a future task — until then
  // the API's own run timeout is the backstop.
  const markCancelled = async (): Promise<Job | null> => {
    return updateJob(input.jobId, {
      status: JobStatus.Cancelled,
      error: "cancelled",
      result: { reason: "cancelled", thread_id: input.threadId },
    });
  };

  try {
    logger.info("agent run started", { attachments: input.attachments.length });

    if (input.signal?.aborted) {
      logger.info("agent run cancelled before start");
      return await markCancelled();
    }

    await updateJob(input.jobId, { status: JobStatus.Running });

    const sessionToken = await new ApiClient({
      baseUrl: config.apiBaseUrl,
      apiKey: input.apiKey,
    }).getEditorSessionToken(input.projectId);
    const headlessUrl = headlessProjectUrl(
      input.projectId,
      sessionToken,
      input.threadId,
    );

    const outcome = await getAgentBrowser().runAgent({
      headlessUrl,
      projectId: input.projectId,
      message: input.prompt,
      attachments: input.attachments,
      threadId: input.threadId,
      maxWaitMs,
    }, progress, input.signal);

    switch (outcome.kind) {
      case "completed":
        return await updateJob(input.jobId, {
          status: JobStatus.Completed,
          last_message: outcome.lastMessage,
          result: {
            project_id: input.projectId,
            project_url: `${config.appBaseUrl}/editor/${input.projectId}`,
            commands_applied: outcome.status.commandExecutions,
            saved: true,
            thread_id: input.threadId,
          },
        });

      case "save_failed":
        return await updateJob(input.jobId, {
          status: JobStatus.Failed,
          last_message: outcome.lastMessage,
          error: `save not confirmed: ${outcome.saveStatus}`,
          result: {
            reason: "save_not_confirmed",
            save_status: outcome.saveStatus,
            thread_id: input.threadId,
          },
        });

      case "timeout":
        return await updateJob(input.jobId, {
          status: JobStatus.Failed,
          last_message: outcome.lastMessage,
          error: `agent exceeded ${maxWaitMs}ms timeout`,
          result: {
            reason: "timeout",
            timeout_ms: maxWaitMs,
            thread_id: input.threadId,
          },
        });

      case "error":
        return await updateJob(input.jobId, {
          status: JobStatus.Failed,
          last_message: outcome.lastMessage,
          error: outcome.error,
          result: {
            reason: "agent_error",
            command_executions: outcome.status.commandExecutions,
            thread_id: input.threadId,
          },
        });

      case "interrupt":
        return await updateJob(input.jobId, {
          status: JobStatus.Failed,
          last_message: outcome.lastMessage,
          error: `unexpected interrupt: ${outcome.status.interruptType ?? "unknown"}`,
          result: {
            reason: "unexpected_interrupt",
            interrupt_type: outcome.status.interruptType ?? null,
            thread_id: input.threadId,
          },
        });

      default:
        return null;
    }
  } catch (err) {
    if (input.signal?.aborted) {
      logger.info("agent run cancelled");
      return await markCancelled();
    }
    if (err instanceof BrowserBusyError) {
      logger.warn("browser worker at capacity", { err });
      return await updateJob(input.jobId, {
        status: JobStatus.Failed,
        error: "browser worker at capacity",
        result: {
          reason: "at_capacity",
          ...(err.retryAfterSeconds
            ? { retry_after_seconds: err.retryAfterSeconds }
            : {}),
        },
      });
    }
    logger.error("agent run failed", { err });
    return await updateJob(input.jobId, {
      status: JobStatus.Failed,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
