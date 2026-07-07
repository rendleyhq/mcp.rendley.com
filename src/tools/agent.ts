import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "@/api/client";
import { projectUrl } from "@/config";
import { runQueued, tryReserveTask, releaseTask } from "@/queue";
import { fail, formatError, outputAny, truncate } from "@/response";
import { runAgentJob } from "@/agent-runner";
import { createJob, getJob, updateJob } from "@/jobs/index";
import { registerJobAbort, unregisterJobAbort } from "@/jobs/cancellation";
import { cancelAgentJob } from "@/agent-cancel";
import type { Job } from "@/types/jobs.types";
import { JobKind, JobStatus } from "@/types/jobs.types";
import { BridgeInterruptType } from "@/types/bridge.types";
import { validateExternalUrl } from "@/utils/url-guard";
import {
  acquireAllOrWait,
  resolveKeys,
  MAX_CONCURRENT_PER_END_USER,
  SLOT_WAIT_TIMEOUT_MS,
} from "@/concurrency-limits";
import { resolveMcpMaxConcurrent } from "@/plan";
import { recordQueueFullRejected } from "@/metrics";
import { log } from "@/logger";
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

// Response for a job that hasn't finished yet — returned by edit_video on start
// and by check_edit while the run is still going.
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
          "⏳ The edit is running in the background — this is expected, most edits take a few minutes.\n\n" +
          progressBlock +
          `Keep polling: call \`check_edit\` with job_id \`${job.job_id}\` again in ~20 seconds. Repeat until it returns a terminal status (completed, failed, or cancelled) — don't stop after one or two checks, and don't tell the user it's done until check_edit confirms it.\n\n` +
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

  if (job.status === JobStatus.Cancelled) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "🛑 This edit was cancelled. Any edits applied before the cancel were saved.\n\n" +
            `Open project: ${url}`,
        },
        projectLink(url),
      ],
      structuredContent: {
        ...structuredContent,
        status: "cancelled",
      },
    };
  }

  // Failed — branch on the runner's terminal reason.
  const reason = result.reason as string | undefined;

  if (reason === "unexpected_interrupt" && result.interrupt_type === BridgeInterruptType.RequestUpgrade) {
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
        interrupt_type: BridgeInterruptType.RequestUpgrade,
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
        'Returns immediately with status "in_progress" and a job_id; the edit runs in the background and usually takes a few minutes. You MUST then poll check_edit with that job_id every ~20s until it reports a terminal status (completed / failed / cancelled) — keep polling until then, do not stop after one or two checks, and do not tell the user it is done until check_edit confirms it. For multiple videos, call this once per video (they run concurrently up to the plan limit, extras queue automatically) and poll each job_id.',
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
    async ({
      project_id,
      message,
      files,
      thread_id,
      continue_conversation,
      end_user_id,
    }) => {
      const logger = log.child({
        projectId: project_id,
        tool: "edit_video",
      });

      // The only hard rejection is the global pending cap; the plan's per-tenant
      // cap makes a request wait for a run slot (below), it doesn't turn it away.
      if (!tryReserveTask()) {
        recordQueueFullRejected();
        logger.warn("pending_cap_reached_edit_video_rejected");
        return fail(
          "The video editor has a lot of edits queued right now. Please retry in a few seconds.",
        );
      }
      let reserved = true;
      const releaseReserved = () => {
        if (reserved) {
          reserved = false;
          releaseTask();
        }
      };

      const maxConcurrent = await resolveMcpMaxConcurrent(apiClient);
      const { tenantKey, endUserKey } = resolveKeys(userId, end_user_id);

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
          kind: JobKind.Agent,
          project_id,
          owner_key_id: apiKeyId,
          thread_id: resolvedThreadId,
        });

        logger.info("edit_video_job_started", {
          jobId: job.job_id,
          threadId: resolvedThreadId,
          files: remoteAttachments.length,
        });

        const abort = registerJobAbort(job.job_id);

        // The plan's concurrent-run cap and the one-edit-per-project lock are
        // enforced here, per run: two concurrent edits on the same project would
        // each load it in a separate tab and race on the save.
        const runReqs = [
          { key: tenantKey, max: maxConcurrent },
          { key: `project:${project_id}`, max: 1 },
        ];
        if (endUserKey !== tenantKey) {
          runReqs.push({ key: endUserKey, max: MAX_CONCURRENT_PER_END_USER });
        }

        // Fire-and-forget: wait for a run slot (so a batch queues instead of being
        // rejected), run, then release everything. The tool returns the job_id now
        // and the client polls check_edit until the job reaches a terminal state.
        void (async () => {
          const slots = await acquireAllOrWait(runReqs, {
            signal: abort.signal,
            timeoutMs: SLOT_WAIT_TIMEOUT_MS,
          });
          if (!slots) {
            // Aborted → the cancel path already set the terminal status. Timed out
            // waiting → record it so the poller gets a definite answer.
            if (!abort.signal.aborted) {
              await updateJob(job.job_id, {
                status: JobStatus.Failed,
                error: "No editor slot became available in time.",
                result: { reason: "slot_wait_timeout" },
              }).catch(() => null);
            }
            unregisterJobAbort(job.job_id);
            releaseReserved();
            return;
          }
          try {
            await runQueued(() =>
              runAgentJob({
                jobId: job.job_id,
                apiKey,
                apiKeyId,
                projectId: project_id,
                prompt: message,
                attachments: remoteAttachments,
                threadId: resolvedThreadId,
                signal: abort.signal,
              }),
            );
          } catch (err) {
            logger.error("agent_job_run_failed", { jobId: job.job_id, err });
            await updateJob(job.job_id, {
              status: JobStatus.Failed,
              error: err instanceof Error ? err.message : String(err),
              result: { reason: "enqueue_failed" },
            }).catch(() => null);
          } finally {
            await slots.release();
            unregisterJobAbort(job.job_id);
            releaseReserved();
          }
        })();

        return formatInProgress(job);
      } catch (err) {
        releaseReserved();
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
        "Poll the status of a video edit started by edit_video. Pass the job_id it returned. While the edit is still running this reports in_progress with recent progress — keep calling it every ~20s until it returns a terminal status (completed / failed / cancelled); only then is the edit actually done. When finished it returns the same result edit_video would have.",
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
      if (!job || job.owner_key_id !== apiKeyId || job.kind !== JobKind.Agent) {
        return fail(
          "This edit could no longer be found — it may have finished a while ago. Run the edit again if you still need it.",
        );
      }

      if (job.status === JobStatus.Pending || job.status === JobStatus.Running) {
        return formatInProgress(job);
      }

      return formatJobResult(job);
    },
  );

  server.registerTool(
    "cancel_edit",
    {
      title: "Cancel edit",
      description:
        "Stop a running video edit that edit_video handed back as in_progress. Pass the job_id it returned; the edit halts and no further work runs.",
      inputSchema: {
        job_id: z
          .string()
          .uuid()
          .describe("The job_id returned by edit_video."),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async ({ job_id }) => {
      const outcome = await cancelAgentJob(job_id, apiKeyId);
      if (outcome.status === "not_found") {
        return fail(
          "This edit could no longer be found — it may have already finished.",
        );
      }
      if (outcome.status === "already_done") {
        return formatJobResult(outcome.job);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "🛑 Edit cancelled. No further work will run for this job.",
          },
        ],
        structuredContent: {
          project_id: outcome.job.project_id,
          project_url: projectUrl(outcome.job.project_id),
          ...(outcome.job.thread_id ? { thread_id: outcome.job.thread_id } : {}),
          status: "cancelled",
          job_id: outcome.job.job_id,
        },
      };
    },
  );
}
