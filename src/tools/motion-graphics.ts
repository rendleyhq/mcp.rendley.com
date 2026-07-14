import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Page } from "playwright";
import { z } from "zod";

import type { ApiClient, Project } from "@/api/client";
import { bridge } from "@/bridge/index";
import {
  acquireAllOrWait,
  resolveKeys,
  SLOT_WAIT_TIMEOUT_MS,
} from "@/concurrency-limits";
import { projectUrl } from "@/config";
import { createJob, getJob, updateJob } from "@/jobs/index";
import { log } from "@/logger";
import { recordQueueFullRejected } from "@/metrics";
import { runMotionClipSession } from "@/motion-clip-runner";
import { resolveMcpMaxConcurrent } from "@/plan";
import { runQueued, tryReserveTask, releaseTask } from "@/queue";
import { fail, formatError, outputAny } from "@/response";
import type {
  BridgeMotionClipResource,
  BridgeMotionGraphicResult,
  BridgeMotionKeyframe,
} from "@/types/bridge.types";
import type { Job } from "@/types/jobs.types";
import { JobKind, JobStatus } from "@/types/jobs.types";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_USER_CODE = 200_000;
const MOTION_CLIP_TYPE = "motion_clip";

// Names exempted from the free-plan paywall in index.ts — keep in sync.
export const MOTION_GRAPHICS_TOOL_NAMES = [
  "get_motion_graphics_guide",
  "list_motion_graphics",
  "get_motion_graphic",
  "get_motion_keyframes",
  "create_motion_graphic",
  "update_motion_graphic",
  "set_motion_keyframes",
  "check_motion_edit",
] as const;

const resourceSchema = z.object({
  id: z.string().describe("Alias the script references, e.g. \"image1\"."),
  type: z.enum(["image", "font"]).optional(),
  label: z.string().optional(),
  mediaId: z.string().optional().describe("Durable library media id (survives reload)."),
  blobUrl: z.string().optional(),
  grabUrl: z.string().optional(),
  fit: z.enum(["cover", "contain", "fill", "none", "scale-down"]).optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
  family: z.string().optional(),
  css: z.string().optional(),
});

const keyframeSchema = z.object({
  time: z.number().describe("Seconds, local to the clip."),
  value: z.union([z.number(), z.array(z.number()), z.string(), z.boolean()]),
  handleIn: z.object({ time: z.number(), value: z.number() }).optional(),
  handleOut: z.object({ time: z.number(), value: z.number() }).optional(),
  hold: z.boolean().optional(),
});

interface MotionToolsDeps {
  apiClient: ApiClient;
  userId: string;
  apiKey: string;
  apiKeyId: string;
}

// --- Reads: parse the serialized project directly (no browser, no timeout) ---

interface RawMotionClip {
  id: string;
  type?: string;
  name?: string;
  startTime?: number;
  duration?: number;
  script?: string;
  properties?: Record<string, unknown>;
  resources?: unknown[];
  width?: number;
  height?: number;
  propertyAnimator?: {
    tracks?: Array<{ property: string; type?: string; keyframes?: unknown[] }>;
  };
}

// Walks project_json's timeline for motion_clip clips. project_json is opaque
// except for the few well-known keys the editor/SDK serialize
// (timeline.layers[].clips[]); we only read fields the MotionClip schema owns.
function parseMotionClips(project: Project): RawMotionClip[] {
  if (!project.project_json) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(project.project_json);
  } catch {
    return [];
  }
  const layers = (doc as { timeline?: { layers?: unknown[] } })?.timeline?.layers;
  if (!Array.isArray(layers)) return [];

  const out: RawMotionClip[] = [];
  for (const layer of layers) {
    const clips = (layer as { clips?: unknown[] })?.clips;
    if (!Array.isArray(clips)) continue;
    for (const clip of clips) {
      if ((clip as RawMotionClip)?.type === MOTION_CLIP_TYPE) {
        out.push(clip as RawMotionClip);
      }
    }
  }
  return out;
}

// --- Async mutation jobs (browser-backed; poll via check_motion_edit) ---

type MotionOp = (page: Page) => Promise<BridgeMotionGraphicResult>;

function projectLink(url: string) {
  return {
    type: "resource_link" as const,
    uri: url,
    name: "Open project",
    mimeType: "text/html",
    description: "Open the Rendley project in the editor",
  };
}

function formatMotionInProgress(job: Job, label: string) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `⏳ ${label} — running in the background (opening the editor headless takes a bit).\n\n` +
          `Poll \`check_motion_edit\` with job_id \`${job.job_id}\` every ~15s until it returns a terminal status (completed / failed). Do not tell the user it is done until then.`,
      },
    ],
    structuredContent: { status: "in_progress" as const, job_id: job.job_id },
  };
}

function formatMotionResult(job: Job) {
  if (job.status === JobStatus.Completed) {
    const result = (job.result ?? {}) as { clip_id?: string; properties?: unknown };
    const url = projectUrl(job.project_id);
    return {
      content: [
        {
          type: "text" as const,
          text:
            `✅ Done.${result.clip_id ? ` Clip \`${result.clip_id}\`.` : ""}\n\nOpen project: ${url}`,
        },
        projectLink(url),
      ],
      structuredContent: {
        status: "completed" as const,
        job_id: job.job_id,
        clip_id: result.clip_id ?? null,
        properties: result.properties ?? null,
      },
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `❌ ${job.status}: ${job.error ?? "unknown error"}`,
      },
    ],
    structuredContent: {
      status: job.status,
      job_id: job.job_id,
      error: job.error ?? null,
    },
  };
}

// Runs the browser-backed op, mapping its outcome onto the job store.
async function runMotionJob(
  deps: MotionToolsDeps,
  projectId: string,
  jobId: string,
  op: MotionOp,
): Promise<void> {
  const logger = log.child({ projectId, jobId, component: "motionJob" });
  await updateJob(jobId, { status: JobStatus.Running });
  try {
    const result = await runMotionClipSession(
      { apiKey: deps.apiKey, projectId, save: true },
      op,
    );
    if (result.error === "__MISSING_MOTION_API__") {
      await updateJob(jobId, {
        status: JobStatus.Failed,
        error: bridge.motionApiMissingError().message,
        result: { reason: "editor_too_old" },
      });
      return;
    }
    if (!result.ok) {
      await updateJob(jobId, {
        status: JobStatus.Failed,
        error: result.error ?? "operation failed",
        result: { reason: "op_failed", error: result.error ?? null },
      });
      return;
    }
    logger.info("motion_job_completed", { clipId: result.clipId });
    await updateJob(jobId, {
      status: JobStatus.Completed,
      result: {
        project_id: projectId,
        clip_id: result.clipId ?? null,
        properties: result.properties ?? null,
      },
    });
  } catch (err) {
    logger.error("motion_job_failed", { err });
    await updateJob(jobId, {
      status: JobStatus.Failed,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Reserves a pending slot, creates the job, and fires the run in the background
// behind the per-project run lock (max 1, so we never race an edit_video save on
// the same project). Returns the job immediately — the caller polls it.
async function startMotionJob(
  deps: MotionToolsDeps,
  projectId: string,
  op: MotionOp,
): Promise<Job> {
  if (!tryReserveTask()) {
    recordQueueFullRejected();
    throw new Error("The editor has a lot of work queued right now. Please retry in a few seconds.");
  }
  let reserved = true;
  const releaseReserved = () => {
    if (reserved) {
      reserved = false;
      releaseTask();
    }
  };

  try {
    const maxConcurrent = await resolveMcpMaxConcurrent(deps.apiClient);
    const { tenantKey } = resolveKeys(deps.userId, undefined);

    const job = await createJob({
      kind: JobKind.MotionGraphic,
      project_id: projectId,
      owner_key_id: deps.apiKeyId,
    });

    const runReqs = [
      { key: tenantKey, max: maxConcurrent },
      { key: `project:${projectId}`, max: 1 },
    ];

    void (async () => {
      const slots = await acquireAllOrWait(runReqs, { timeoutMs: SLOT_WAIT_TIMEOUT_MS });
      if (!slots) {
        await updateJob(job.job_id, {
          status: JobStatus.Failed,
          error: "No editor slot became available in time.",
          result: { reason: "slot_wait_timeout" },
        }).catch(() => null);
        releaseReserved();
        return;
      }
      try {
        await runQueued(() => runMotionJob(deps, projectId, job.job_id, op));
      } finally {
        await slots.release();
        releaseReserved();
      }
    })();

    return job;
  } catch (err) {
    releaseReserved();
    throw err;
  }
}

export function registerMotionGraphicsTools(server: McpServer, deps: MotionToolsDeps) {
  const { apiClient } = deps;

  server.registerTool(
    "get_motion_graphics_guide",
    {
      title: "Motion graphics authoring guide",
      description:
        "Return the authoring guide for writing motion-graphic userCode: the required worker structure (propertyDefines, setProperty, setProperties, draw, svgStringToBase64), the HTML-in-SVG-foreignObject rendering approach, resource/font helpers, and design rules. ALWAYS read this before calling create_motion_graphic or update_motion_graphic for the first time.",
      inputSchema: {},
      outputSchema: outputAny,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const guide = await apiClient.getMotionClipGuide();
        return {
          content: [
            {
              type: "text" as const,
              text:
                "# Motion graphics — code rules\n\n" +
                guide.code_rules +
                "\n\n# Motion graphics — design guide\n\n" +
                guide.design_guide,
            },
          ],
          structuredContent: { code_rules: guide.code_rules, design_guide: guide.design_guide },
        };
      } catch (err) {
        return fail(`Could not fetch the motion graphics guide: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "list_motion_graphics",
    {
      title: "List motion graphics",
      description:
        "List the motion-graphic clips (animated titles, lower thirds, callouts, kinetic type, etc.) currently on a project's timeline, with their clip ids and timing. Fast (reads the saved project). Use it to find a clip id before get_motion_graphic or update_motion_graphic.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project to inspect"),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id }) => {
      try {
        const project = await apiClient.getProject(project_id);
        const clips = parseMotionClips(project).map((c) => ({
          clipId: c.id,
          name: c.name ?? "",
          startTime: c.startTime ?? 0,
          duration: c.duration ?? 0,
        }));
        const lines = clips.length
          ? clips
              .map(
                (c) =>
                  `- \`${c.clipId}\` — ${c.name || "(unnamed)"} @ ${c.startTime.toFixed(2)}s for ${c.duration.toFixed(2)}s`,
              )
              .join("\n")
          : "No motion graphics on this project's timeline yet.";
        return {
          content: [{ type: "text" as const, text: lines }],
          structuredContent: { motion_graphics: clips },
        };
      } catch (err) {
        return fail(`Could not list motion graphics: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "get_motion_graphic",
    {
      title: "Get a motion graphic",
      description:
        "Return a motion-graphic clip's editable script (userCode), its current property values, resources, and dimensions. Fast (reads the saved project). The returned user_code is the exact slice you edit and pass back to update_motion_graphic — the worker boilerplate is stripped for you.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project the clip is in"),
        clip_id: z.string().regex(ID_RE).describe("Motion-graphic clip id (from list_motion_graphics)"),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, clip_id }) => {
      try {
        const project = await apiClient.getProject(project_id);
        const clip = parseMotionClips(project).find((c) => c.id === clip_id);
        if (!clip) {
          return fail(`No motion-graphic clip with id \`${clip_id}\` on project ${project_id}.`);
        }
        const userCode = clip.script ? await apiClient.extractMotionClipUserCode(clip.script) : "";
        const properties = Object.entries(clip.properties ?? {}).map(([name, value]) => ({ name, value }));
        const propLines = properties.map((p) => `- ${p.name} = ${JSON.stringify(p.value)}`).join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**${clip.name || "Motion graphic"}** \`${clip.id}\` — ${clip.width ?? "?"}×${clip.height ?? "?"}, ${(clip.duration ?? 0).toFixed(2)}s\n\n` +
                (propLines ? `Properties:\n${propLines}\n\n` : "") +
                "```js\n" + userCode + "\n```",
            },
          ],
          structuredContent: {
            clip_id: clip.id,
            name: clip.name ?? "",
            user_code: userCode,
            properties,
            resources: clip.resources ?? [],
            width: clip.width ?? null,
            height: clip.height ?? null,
            duration: clip.duration ?? null,
            start_time: clip.startTime ?? null,
          },
        };
      } catch (err) {
        return fail(`Could not get motion graphic: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "get_motion_keyframes",
    {
      title: "Get motion-graphic keyframes",
      description:
        "Return the keyframe tracks currently set on a motion-graphic clip, keyed by property name. Fast (reads the saved project).",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project the clip is in"),
        clip_id: z.string().regex(ID_RE).describe("Motion-graphic clip id"),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, clip_id }) => {
      try {
        const project = await apiClient.getProject(project_id);
        const clip = parseMotionClips(project).find((c) => c.id === clip_id);
        if (!clip) {
          return fail(`No motion-graphic clip with id \`${clip_id}\` on project ${project_id}.`);
        }
        const tracks: Record<string, unknown> = {};
        for (const t of clip.propertyAnimator?.tracks ?? []) {
          tracks[t.property] = t.keyframes ?? [];
        }
        const names = Object.keys(tracks);
        return {
          content: [
            {
              type: "text" as const,
              text: names.length ? `Keyframed properties: ${names.join(", ")}` : "No keyframes on this clip.",
            },
          ],
          structuredContent: { clip_id, tracks },
        };
      } catch (err) {
        return fail(`Could not get keyframes: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "create_motion_graphic",
    {
      title: "Create a motion graphic",
      description:
        "Create a motion-graphic clip from JavaScript you author (userCode: propertyDefines, setProperty, setProperties, draw, svgStringToBase64 — HTML/CSS baked into an SVG foreignObject, drawn with createImageBitmap). Read get_motion_graphics_guide first. The worker boilerplate is appended automatically; do not include it. No Rendley credits are charged. Runs in the background: returns a job_id — poll check_motion_edit until it reports completed/failed.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project to add the clip to"),
        user_code: z.string().min(1).max(MAX_USER_CODE).describe("The motion-clip userCode (see the authoring guide). Boilerplate is appended for you."),
        duration: z.number().gt(0).lte(600).describe("Clip duration in seconds"),
        width: z.number().int().gt(0).lte(4096).optional().describe("Logical width (default 1080)"),
        height: z.number().int().gt(0).lte(4096).optional().describe("Logical height (default 1080)"),
        start_time: z.number().gte(0).optional().describe("Start time on the timeline in seconds"),
        layer_id: z.string().regex(ID_RE).optional().describe("Target layer id; a new layer is created if omitted"),
        name: z.string().max(256).optional(),
        resources: z.array(resourceSchema).max(32).optional().describe("Image/font resources referenced by resolveResource(id)"),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, user_code, duration, width, height, start_time, layer_id, name, resources }) => {
      try {
        const script = await apiClient.buildMotionClipScript(user_code);
        const job = await startMotionJob(deps, project_id, (page) =>
          bridge.addMotionGraphic(page, {
            script,
            duration,
            width,
            height,
            startTime: start_time,
            layerId: layer_id,
            name,
            resources: resources as BridgeMotionClipResource[] | undefined,
          }),
        );
        return formatMotionInProgress(job, "Creating motion graphic");
      } catch (err) {
        return fail(`Could not create motion graphic: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "update_motion_graphic",
    {
      title: "Update a motion graphic",
      description:
        "Update an existing motion-graphic clip: replace its script (user_code, boilerplate appended for you) and/or set property values. Get the current user_code with get_motion_graphic first, edit it, and pass it back. No Rendley credits are charged. Runs in the background: returns a job_id — poll check_motion_edit.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project the clip is in"),
        clip_id: z.string().regex(ID_RE).describe("Motion-graphic clip id"),
        user_code: z.string().min(1).max(MAX_USER_CODE).optional().describe("New userCode. Omit to only change properties."),
        properties: z.record(z.string(), z.unknown()).optional().describe("Property name → new value. Applied after any script change."),
        resources: z.array(resourceSchema).max(32).optional().describe("Replaces the clip's resources when provided"),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, clip_id, user_code, properties, resources }) => {
      try {
        if (!user_code && !properties) {
          return fail("Nothing to update: provide user_code and/or properties.");
        }
        const script = user_code ? await apiClient.buildMotionClipScript(user_code) : null;
        const propEntries = properties ? Object.entries(properties) : [];

        const job = await startMotionJob(deps, project_id, async (page) => {
          if (script) {
            const r = await bridge.updateMotionGraphicScript(page, clip_id, {
              script,
              resources: resources as BridgeMotionClipResource[] | undefined,
            });
            if (r.error === "__MISSING_MOTION_API__" || !r.ok) return r;
          }
          const failed: string[] = [];
          for (const [name, value] of propEntries) {
            const r = await bridge.setMotionGraphicProperty(page, clip_id, name, value);
            if (r.error === "__MISSING_MOTION_API__") return r as BridgeMotionGraphicResult;
            if (!r.ok) failed.push(`${name}: ${r.error ?? "failed"}`);
          }
          if (failed.length) {
            return { ok: false, error: `Some properties could not be set: ${failed.join("; ")}` };
          }
          return { ok: true, clipId: clip_id };
        });
        return formatMotionInProgress(job, "Updating motion graphic");
      } catch (err) {
        return fail(`Could not update motion graphic: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "set_motion_keyframes",
    {
      title: "Set motion-graphic keyframes",
      description:
        "Animate a motion-graphic clip's property over time with keyframes (bezier easing via handleIn/handleOut, or hold). Animatable properties include the clip's own properties plus position, scale, rotation and alpha. By default keyframes are added to the existing track; pass reset=true to replace it. Runs in the background: returns a job_id — poll check_motion_edit.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project the clip is in"),
        clip_id: z.string().regex(ID_RE).describe("Motion-graphic clip id"),
        property: z.string().describe("Animatable property name (e.g. position, alpha, or a clip property)"),
        keyframes: z.array(keyframeSchema).min(1).max(256),
        reset: z.boolean().optional().describe("Replace the property's existing track instead of appending"),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, clip_id, property, keyframes, reset }) => {
      try {
        const job = await startMotionJob(deps, project_id, (page) =>
          bridge
            .setMotionGraphicKeyframes(page, clip_id, property, keyframes as BridgeMotionKeyframe[], reset)
            .then((r) => ({ ...r, clipId: clip_id })),
        );
        return formatMotionInProgress(job, `Setting keyframes on ${property}`);
      } catch (err) {
        return fail(`Could not set keyframes: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "check_motion_edit",
    {
      title: "Check motion-graphic job",
      description:
        "Poll a motion-graphic job started by create_motion_graphic, update_motion_graphic, or set_motion_keyframes. Pass the job_id it returned. Keep calling every ~15s until it returns a terminal status (completed / failed).",
      inputSchema: {
        job_id: z.string().uuid().describe("The job_id returned by a motion-graphic mutation."),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ job_id }) => {
      try {
        const job = await getJob(job_id);
        if (!job) return fail(`No motion-graphic job with id ${job_id}.`);
        if (job.status === JobStatus.Pending || job.status === JobStatus.Running) {
          return formatMotionInProgress(job, "Working");
        }
        return formatMotionResult(job);
      } catch (err) {
        return fail(`Could not check job: ${formatError(err)}`);
      }
    },
  );
}
