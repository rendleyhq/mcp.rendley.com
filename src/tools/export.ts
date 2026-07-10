import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "@/api/client";
import { config } from "@/config";
import { bytes, fail, formatError, outputAny } from "@/response";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type JobLikeStatus = "queued" | "processing" | "completed" | "failed" | "canceled";

const STATUS_MAX_WAIT_CEILING_MS = 240_000;
const STATUS_MAX_WAIT_MS = Math.min(
  config.exportPollTimeoutMs,
  STATUS_MAX_WAIT_CEILING_MS,
);

interface ExportResultData {
  status?: "ok" | "error";
  storage_url?: string;
  size?: number;
  mime_type?: string;
  extension?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  code?: string;
  error?: string;
}

function formatSpecs(result: ExportResultData): string {
  const parts: string[] = [];
  if (result.width && result.height) parts.push(`${result.width}×${result.height}`);
  if (result.size) parts.push(bytes(result.size));
  return parts.join(" · ");
}

function buildExportResponse(exportId: string, result: ExportResultData) {
  if (!result.storage_url) {
    return fail("Export finished but no download link was returned.");
  }

  const specs = formatSpecs(result);
  const summary =
    `🎬 Export ready${specs ? `: ${specs}` : ""}\n\n` +
    `Download link: ${result.storage_url}\n\n` +
    `_The link expires in a few hours._`;

  return {
    content: [
      { type: "text" as const, text: summary },
      {
        type: "resource_link" as const,
        uri: result.storage_url,
        name: `export.${result.extension ?? "mp4"}`,
        mimeType: result.mime_type ?? "video/mp4",
        description: "Exported video. Link expires in a few hours",
        ...(result.size ? { size: result.size } : {}),
      },
    ],
    structuredContent: {
      export_id: exportId,
      status: "completed" as const,
      storage_url: result.storage_url,
      ...(result.mime_type ? { mime_type: result.mime_type } : {}),
      ...(result.size ? { size: result.size } : {}),
      ...(result.width && result.height
        ? { width: result.width, height: result.height }
        : {}),
    },
  };
}

function parseResultData(raw: string | null): ExportResultData | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ExportResultData;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollExport(apiClient: ApiClient, exportId: string) {
  const deadline = Date.now() + STATUS_MAX_WAIT_MS;
  let lastStatus: JobLikeStatus = "queued";

  for (;;) {
    let job;
    try {
      job = await apiClient.getJob(exportId);
    } catch (err) {
      if (Date.now() >= deadline) {
        return fail(`Could not read export status: ${formatError(err)}`);
      }
      await sleep(config.exportPollIntervalMs);
      continue;
    }

    lastStatus = job.status;

    if (job.status === "completed") {
      const result = parseResultData(job.result_data);
      if (!result) {
        return fail("Export completed but the result could not be read.");
      }
      return buildExportResponse(exportId, result);
    }

    if (job.status === "failed" || job.status === "canceled") {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ Export ${job.status}: ${job.error ?? "unknown error"}`,
          },
        ],
        isError: true,
        structuredContent: { export_id: exportId, status: job.status, error: job.error ?? null },
      };
    }

    if (Date.now() >= deadline) {
      break;
    }
    await sleep(config.exportPollIntervalMs);
  }

  return {
    content: [
      {
        type: "text" as const,
        text:
          `⏳ Export still ${lastStatus} (id \`${exportId}\`). ` +
          "Call `check_export` with this id to keep waiting.",
      },
    ],
    structuredContent: { export_id: exportId, status: lastStatus },
  };
}

export function registerExportTools(server: McpServer, apiClient: ApiClient) {
  server.registerTool(
    "export_project",
    {
      title: "Export video",
      description:
        "Only use this when the user explicitly asks to export or download the video; creating or editing a project does not mean they want it exported. Render a project into a finished video file and wait for it. If the render finishes in time, this returns the download link; if it takes longer than a few minutes, it returns an export id, so call `check_export` with that id to keep waiting. Exporting through this tool needs a paid plan. If the user is on the free plan, tell them to open the project (the project_url) and export from there, where 720p is free.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project to export"),
        codec: z
          .enum(["h264", "vp8"])
          .optional()
          .describe("Video codec. Default h264 (MP4). Use vp8 for WebM."),
        target_resolution: z
          .enum(["720p", "1080p", "4K"])
          .optional()
          .describe("Output resolution, one of 720p, 1080p, or 4K. Defaults to 1080p."),
        quality: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("Output quality. Default: high."),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ project_id, codec, target_resolution, quality }) => {
      let jobId: string;
      try {
        const created = await apiClient.createExportJob({
          projectId: project_id,
          codec,
          targetResolution: target_resolution,
          quality,
        });
        jobId = created.job_id;
      } catch (err) {
        return fail(`Export failed to start: ${formatError(err)}`);
      }
      return pollExport(apiClient, jobId);
    },
  );

  server.registerTool(
    "check_export",
    {
      title: "Check export",
      description:
        "Continue waiting for an export, using the export id export_project returned when it was still rendering. Waits up to a few minutes and returns the download link when ready, or asks you to call again if it is still going.",
      inputSchema: {
        export_id: z
          .string()
          .regex(ID_RE)
          .describe("The export id returned by export_project."),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ export_id }) => pollExport(apiClient, export_id),
  );
}
