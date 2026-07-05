import { createHash } from "crypto";
import { ApiClient } from "@/api/client";
import { config, headlessProjectUrl } from "@/config";
import { getAgentBrowser } from "@/sdk/browser-factory";
import { BrowserBusyError } from "@/sdk/remote-browser";
import { updateJob } from "@/jobs/index";
import { log } from "@/logger";
import type { BridgeAttachment } from "@/types/bridge.types";
import type { Job } from "@/types/jobs.types";
import { JobStatus } from "@/types/jobs.types";

// Keep only the most recent progress lines on the job record.
const PROGRESS_RING_SIZE = 20;

// Stable warm-session key: same tenant + project + thread reuses the held
// browser on the worker; anything else is a miss. Hashed so no identifiers
// leak into worker logs.
function sessionKeyFor(apiKeyId: string, projectId: string, threadId: string): string {
  return createHash("sha256")
    .update(`${apiKeyId}:${projectId}:${threadId}`)
    .digest("hex")
    .slice(0, 32);
}

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
}

// Runs the browser-mediated agent edit and writes the terminal state to the
// job store. Returns the final job record so synchronous callers (the hybrid
// edit_video window) can use the result without re-reading the store.
export async function runAgentJob(input: RunInput): Promise<Job | null> {
  const maxWaitMs = input.maxWaitMs ?? config.agentTimeoutMs;
  const logger = log.child({
    jobId: input.jobId,
    projectId: input.projectId,
    component: "agentRunner",
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

  try {
    logger.info("start", { attachments: input.attachments.length });

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
      ...(config.sessionHoldMs > 0
        ? {
            sessionKey: sessionKeyFor(input.apiKeyId, input.projectId, input.threadId),
            holdMs: config.sessionHoldMs,
          }
        : {}),
    }, progress);

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
    if (err instanceof BrowserBusyError) {
      logger.warn("browser_busy", { err });
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
    logger.error("failed", { err });
    return await updateJob(input.jobId, {
      status: JobStatus.Failed,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
