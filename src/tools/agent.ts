import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "@/api/client";
import { config, projectUrl } from "@/config";
import { isQueueFull, runQueued } from "@/queue";
import { fail, formatError, outputAny, truncate } from "@/response";
import { runAgentJob } from "@/agent-runner";
import { createJob, getJob, updateJob } from "@/jobs/index";
import type { Job } from "@/types/jobs.types";
import { JobStatus } from "@/types/jobs.types";
import { acquireAll, releaseAll, resolveKeys } from "@/concurrency-limits";
import { resolvePlanCap } from "@/plan-cache";
import { validateExternalUrl } from "@/utils/url-guard";
import { recordConcurrencyRejected, recordQueueFullRejected } from "@/metrics";
import { log } from "@/logger";
import { progressFromExtra } from "@/mcp/progress";
import type { BridgeAttachment } from "@/types/bridge.types";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_FILES = 100;

function projectLink(url: string) {
  return {
    type: "resource_link" as const,
    uri: url,
    name: "Open project",
    mimeType: "text/html",
    description: "Open the Rendley project in the editor",
  };
}

function jobResult(job: Job): Record<string, unknown> {
  return (job.result ?? {}) as Record<string, unknown>;
}

function jobThreadId(job: Job): string | null {
  return job.thread_id ?? (jobResult(job).thread_id as string | undefined) ?? null;
}

// Response for a job that hasn't finished yet — returned when the synchronous
// window expires and by check_edit while the run is still going.
function formatInProgress(job: Job) {
  const url = projectUrl(job.project_id);
  const threadId = jobThreadId(job);
  const recent = (job.progress ?? []).slice(-5);
  const progressBlock = recent.length
    ? `Recent progress:\n${recent.map((line) => `- ${line}`).join("\n")}\n\n`
    : "";

  return {
    content: [
      {
        type: "text" as const,
        text:
          "⏳ The edit is running in the background — this is normal for bigger edits.\n\n" +
          progressBlock +
          `Call \`check_edit\` with job_id \`${job.job_id}\` in ~20 seconds to get the result.\n\n` +
          `Open project: ${url}`,
      },
      projectLink(url),
    ],
    structuredContent: {
      project_id: job.project_id,
      project_url: url,
      ...(threadId ? { thread_id: threadId } : {}),
      status: "in_progress",
      job_id: job.job_id,
    },
  };
}

// Renders a terminal job record in the same shapes the synchronous edit_video
// responses have always used, so fast edits stay byte-compatible and
// check_edit results look identical to an in-window completion.
function formatJobResult(job: Job) {
  const url = projectUrl(job.project_id);
  const threadId = jobThreadId(job);
  const result = jobResult(job);
  const lastMessage = job.last_message ?? "";
  const structuredContent = {
    project_id: job.project_id,
    project_url: url,
    ...(threadId ? { thread_id: threadId } : {}),
  };

  if (job.status === JobStatus.Completed) {
    const cmdCount = (result.commands_applied as number | undefined) ?? 0;
    if (cmdCount === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              "⚠️ Agent finished without executing any editor commands. The timeline is unchanged.\n\n" +
              `> ${truncate(lastMessage || "(no message)", 400)}\n\n` +
              'Retry with more explicit instructions (for example: *"Use the editor tools to add three text clips on layer 0 at 0s, 3s, 6s"*).\n\n' +
              `Open project: ${url}`,
          },
          projectLink(url),
        ],
        structuredContent: {
          ...structuredContent,
          status: "completed",
          command_executions: cmdCount,
        },
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text:
            `✅ Agent completed. ${cmdCount} command${cmdCount === 1 ? "" : "s"} applied, saved.\n\n` +
            `> ${truncate(lastMessage || "(no message)", 400)}\n\n` +
            `Open project: ${url}`,
        },
        projectLink(url),
      ],
      structuredContent: {
        ...structuredContent,
        status: "completed",
        command_executions: cmdCount,
      },
    };
  }

  // Failed — branch on the runner's terminal reason.
  const reason = result.reason as string | undefined;

  if (reason === "unexpected_interrupt" && result.interrupt_type === "request_upgrade") {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "⛔ This isn't available on the user's current plan.\n\n" +
            `> ${truncate(lastMessage || "(no message)", 400)}\n\n` +
            "Let the user know this requires a paid plan.\n\n" +
            `Open project: ${url}`,
        },
        projectLink(url),
      ],
      structuredContent: {
        ...structuredContent,
        status: "needs_upgrade",
        interrupt_type: "request_upgrade",
      },
    };
  }

  if (reason === "save_not_confirmed") {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `⚠️ Save not confirmed (status: ${result.save_status ?? "unknown"})\n\n` +
            `> ${truncate(lastMessage || "Agent completed", 400)}\n\n` +
            "Call `edit_video` again to retry.\n\n" +
            `Open project: ${url}`,
        },
        projectLink(url),
      ],
      structuredContent: {
        ...structuredContent,
        status: "save_failed",
        save_status: result.save_status ?? "unknown",
      },
    };
  }

  if (reason === "timeout") {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "⏱ The edit hit its time limit and was stopped. Edits applied before the cutoff were saved.\n\n" +
            `> ${truncate(lastMessage || "(no message)", 400)}\n\n` +
            "Check the project, then retry with a smaller scope if needed.\n\n" +
            `Open project: ${url}`,
        },
        projectLink(url),
      ],
      structuredContent: {
        ...structuredContent,
        status: "error",
        error: job.error ?? "timeout",
      },
    };
  }

  if (reason === "at_capacity") {
    const retryHint = result.retry_after_seconds
      ? ` Please retry in ${result.retry_after_seconds} seconds.`
      : " Please retry in a few seconds.";
    return {
      content: [
        {
          type: "text" as const,
          text: `The video editor is at capacity right now.${retryHint}`,
        },
      ],
      structuredContent: {
        ...structuredContent,
        status: "error",
        error: "at_capacity",
      },
    };
  }

  const cmdCount = (result.command_executions as number | undefined) ?? 0;
  return {
    content: [
      {
        type: "text" as const,
        text:
          `⚠️ The agent couldn't complete this request: ${truncate(job.error ?? "unknown error", 400)}\n\n` +
          (cmdCount > 0
            ? `${cmdCount} command${cmdCount === 1 ? "" : "s"} were applied before it stopped (saved).\n\n`
            : "No changes were made to the timeline.\n\n") +
          `Open project: ${url}`,
      },
      projectLink(url),
    ],
    structuredContent: {
      ...structuredContent,
      status: "error",
      error: job.error ?? "unknown error",
      command_executions: cmdCount,
    },
  };
}

export interface AgentToolDeps {
  apiClient: ApiClient;
  userId: string;
  apiKey: string;
  apiKeyId: string;
}

export function registerAgentTools(server: McpServer, deps: AgentToolDeps) {
  const { apiClient, userId, apiKey, apiKeyId } = deps;

  server.registerTool(
    "edit_video",
    {
      title: "Edit video",
      description:
        "Create or edit a video through text, using the user's own footage or letting Rendley supply it. Use it for any video creation or editing task. " +
        "Fast edits return the result directly; longer edits return status \"in_progress\" with a job_id — call check_edit with it to get the result.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project to work on"),
        message: z
          .string()
          .min(1)
          .max(MAX_MESSAGE_CHARS)
          .describe(
            "Complete instructions for the video. Be specific about what you want. The editor handles searching, generating, and editing.",
          ),
        files: z
          .array(
            z.object({
              url: z
                .string()
                .url()
                .max(4096)
                .describe(
                  "A public https link to the media. Local file paths aren't supported.",
                ),
              media_id: z
                .string()
                .regex(ID_RE)
                .optional()
                .describe(
                  "Optional. When you added the file with add_files, pass back the id it returned so the same file is reused.",
                ),
              name: z
                .string()
                .max(256)
                .optional()
                .describe("Optional display name."),
            }),
          )
          .max(MAX_FILES)
          .optional()
          .describe(
            "The user's media to bring into the project first. Use public https links, or for their own local files add them with add_files and pass back what it returns.",
          ),
        continue_conversation: z
          .boolean()
          .optional()
          .describe(
            "Resume this project's most recent agent conversation so prior context carries over. Defaults to starting a new conversation. Ignored when thread_id is given.",
          ),
        thread_id: z
          .string()
          .regex(ID_RE)
          .optional()
          .describe(
            "Advanced: continue a specific earlier conversation by the id a prior edit_video returned. Usually unnecessary; omit to start fresh, or set continue_conversation to resume the latest.",
          ),
        end_user_id: z
          .string()
          .regex(ID_RE)
          .optional()
          .describe(
            "Optional. Identifies the downstream end user on whose behalf this edit runs, so per-user concurrency limits apply. Omit for single-user keys.",
          ),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (
      { project_id, message, files, thread_id, continue_conversation, end_user_id },
      extra,
    ) => {
      const logger = log.child({
        projectId: project_id,
        tool: "edit_video",
      });

      if (isQueueFull()) {
        recordQueueFullRejected();
        logger.warn("queue_full_edit_video_rejected");
        return fail(
          "The video editor is at capacity right now. Please retry in a few seconds.",
        );
      }

      const planCap = await resolvePlanCap(userId, apiClient);
      const { tenantKey, endUserKey } = resolveKeys(userId, end_user_id);
      const reqs = [{ key: tenantKey, max: planCap }];
      if (endUserKey !== tenantKey) {
        reqs.push({ key: endUserKey, max: config.maxConcurrentPerEndUser });
      }
      const acquiredKeys = reqs.map((r) => r.key);
      if (!acquireAll(reqs)) {
        recordConcurrencyRejected();
        logger.warn("concurrency_limit_exceeded");
        return fail(
          "You have too many edits running right now. Please wait for one to finish and retry.",
        );
      }
      const releaseSlots = () => releaseAll(acquiredKeys);

      // Slots are released by the background run's finally once it launches;
      // before that, error paths release here.
      let backgroundLaunched = false;
      try {
        let resolvedThreadId: string | null = thread_id ?? null;
        if (!resolvedThreadId && continue_conversation) {
          resolvedThreadId = await apiClient.getLastAgentThread(project_id);
        }
        if (!resolvedThreadId) {
          resolvedThreadId = await apiClient.createAgentThread(project_id);
        }

        const remoteAttachments: BridgeAttachment[] = (files ?? []).map(
          (file) => ({
            storage_url: file.url,
            ...(file.media_id ? { media_id: file.media_id } : {}),
            ...(file.name?.trim() ? { name: file.name.trim() } : {}),
          }),
        );

        for (const attachment of remoteAttachments) {
          if (attachment.storage_url) {
            validateExternalUrl(attachment.storage_url);
          }
        }

        const job = await createJob({
          kind: "agent",
          project_id,
          owner_key_id: apiKeyId,
          thread_id: resolvedThreadId,
        });

        logger.info("edit_video_job_started", {
          jobId: job.job_id,
          threadId: resolvedThreadId,
          files: remoteAttachments.length,
        });

        // Forward live progress to the MCP client only while the synchronous
        // window is open; the runner keeps persisting it on the job either way.
        const mcpProgress = progressFromExtra(extra);
        let windowOpen = true;

        const runPromise = runQueued(() =>
          runAgentJob({
            jobId: job.job_id,
            apiKey,
            apiKeyId,
            projectId: project_id,
            prompt: message,
            attachments: remoteAttachments,
            threadId: resolvedThreadId,
            onProgress: (msg) => {
              if (windowOpen) return mcpProgress(msg);
            },
          }),
        )
          .catch(async (err) => {
            logger.error("agent_job_run_failed", { jobId: job.job_id, err });
            return await updateJob(job.job_id, {
              status: JobStatus.Failed,
              error: err instanceof Error ? err.message : String(err),
              result: { reason: "enqueue_failed" },
            }).catch(() => null);
          })
          .finally(releaseSlots);
        backgroundLaunched = true;

        // Hybrid contract: give fast edits a one-shot synchronous answer, and
        // hand longer ones back as a job_id for check_edit polling instead of
        // blocking past typical MCP client timeouts.
        let windowTimer: ReturnType<typeof setTimeout> | undefined;
        const raced = await Promise.race([
          runPromise.then((finished) => ({ done: true as const, finished })),
          new Promise<{ done: false }>((resolve) => {
            windowTimer = setTimeout(() => resolve({ done: false }), config.syncWindowMs);
          }),
        ]);
        if (windowTimer) clearTimeout(windowTimer);
        windowOpen = false;

        if (raced.done && raced.finished) {
          return formatJobResult(raced.finished);
        }

        const current = await getJob(job.job_id).catch(() => null);
        return formatInProgress(current ?? job);
      } catch (err) {
        if (!backgroundLaunched) releaseSlots();
        logger.error("send_failed", { err });
        return fail(`Agent message failed: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "check_edit",
    {
      title: "Check edit status",
      description:
        "Check on a video edit that edit_video handed back as in_progress. Pass the job_id it returned; when the edit finishes this returns the same result edit_video would have.",
      inputSchema: {
        job_id: z
          .string()
          .uuid()
          .describe("The job_id returned by edit_video when the edit went to the background."),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ job_id }) => {
      const job = await getJob(job_id);
      // Wrong-owner reads the same as missing so job ids can't be enumerated.
      if (!job || job.owner_key_id !== apiKeyId || job.kind !== "agent") {
        return fail(
          "No edit job found with this id — it may have expired (results are kept for about 24 hours). Re-run edit_video if needed.",
        );
      }

      if (job.status === JobStatus.Pending || job.status === JobStatus.Running) {
        return formatInProgress(job);
      }

      return formatJobResult(job);
    },
  );
}
