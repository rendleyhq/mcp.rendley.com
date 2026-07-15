import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ApiClient, Project } from "@/api/client";
import { bridge } from "@/bridge/index";
import { resolveKeys } from "@/concurrency-limits";
import { config, projectUrl } from "@/config";
import { isJobTerminal, updateJob, waitForJob } from "@/jobs/index";
import { launchQueuedJob } from "@/jobs/launcher";
import { log } from "@/logger";
import { preflightMotionScript } from "@/motion-clip-preflight";
import { runMotionClipSession, type MotionOpSpec } from "@/motion-clip-runner";
import { resolveMcpMaxConcurrent } from "@/plan";
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
  "batch_motion_graphics",
] as const;

const MAX_BATCH_OPERATIONS = 32;

const resourceSchema = z.object({
  id: z.string().describe("Alias the userCode references via renderResource(id)/getResource(id), e.g. \"image1\"."),
  type: z.enum(["image", "font"]).optional(),
  label: z.string().optional(),
  mediaId: z
    .string()
    .optional()
    .describe(
      "Id from the project's EDITOR library (inside project_json) — NOT the backend media id from add_files; those never resolve. When unsure, use blobUrl instead.",
    ),
  blobUrl: z
    .string()
    .optional()
    .describe("Public, fetchable image URL — the easiest reliable source (e.g. add_files storage_url)."),
  grabUrl: z.string().optional().describe("Public, fetchable image URL fallback."),
  fit: z.enum(["cover", "contain", "fill", "none", "scale-down"]).optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
  family: z.string().optional().describe("Font only: exact font-family name."),
  css: z.string().optional().describe("Font only: self-contained @font-face CSS with inline base64 data."),
});

// Appended to the shared guide for external (MCP) authors. The shared code
// rules/design guide were written for the in-editor agent, where the platform
// supplies the resource list — external authors must be told they get NOTHING
// implicitly, or they invent aliases that resolve to broken images.
const RESOURCE_CONTRACT_GUIDE = `# Image & font resources — MCP authoring contract (MANDATORY)

- Resources are OPTIONAL, and most motion graphics need NONE: draw shapes, gradients, patterns, charts and iconography with SVG/CSS, and use emoji/Unicode glyphs for simple icons.
- Declare a resource ONLY for real media you actually have:
  - \`blobUrl\` / \`grabUrl\` — a public, fetchable image URL. This is the EASIEST reliable source (e.g. the storage_url from add_files, or any public image URL).
  - \`mediaId\` — an id from this project's EDITOR library (the ids inside project_json's library, also echoed back by get_motion_graphic resources). ⚠️ This is NOT the media id returned by add_files or listed on the backend project — those are a different namespace and will be rejected. When in doubt, use blobUrl.
  - Fonts need \`family\` + \`css\` (a self-contained @font-face with inline base64 data). No font file? Use a web-safe stack instead.
- NEVER invent an alias (e.g. "plate", "logo", "hero") expecting the platform to supply it — it will not. A declared resource with no source, a reference to an undeclared alias, or a mediaId that isn't in the editor library is rejected before the clip is created.
- In userCode, place images ONLY via \`renderResource(id, { width, height, radius? })\` and read natural size with \`getResource(id)\` — never your own object-fit math.`;

// Aliases the userCode references by string literal, via the resource helpers
// the worker header provides.
const RESOURCE_REF_RE = /\b(?:resolveResource|getResource|renderResource|getResourceStyle)\(\s*["'`]([^"'`]+)["'`]/g;

type ResourceInput = z.infer<typeof resourceSchema>;

// Enforces the resource contract BEFORE a browser ever launches. The editor
// resolves resources lazily and non-fatally: a declared resource with no source
// (an invented alias like "plate") creates a clip that *reports success* but
// renders with holes and a console error. Reject it here with an instruction
// the authoring LLM can act on instead.
function validateResourceContract(input: {
  userCode?: string;
  resources?: ResourceInput[];
  // Skip the userCode-reference check when an update keeps the clip's existing
  // resources (undefined) — those aliases are valid but unknown to us here.
  checkReferences: boolean;
  ctx: string;
}): string | null {
  const declared = new Set<string>();
  for (const resource of input.resources ?? []) {
    declared.add(resource.id);
    if (resource.type === "font") {
      if (!resource.family || !resource.css) {
        return `${input.ctx}: font resource "${resource.id}" must include both family and css (a self-contained @font-face with inline base64 data). If you don't have the font file, drop the resource and use a web-safe font stack in the userCode instead.`;
      }
      continue;
    }
    if (!resource.mediaId && !resource.blobUrl && !resource.grabUrl) {
      return `${input.ctx}: image resource "${resource.id}" has no source. Every image resource must reference REAL media — a mediaId from this project's library, or a public fetchable URL in blobUrl/grabUrl. Never declare placeholder aliases the platform is supposed to fill in (it won't). If you don't have an actual image, remove the resource and draw that element with SVG/CSS/emoji in the userCode.`;
    }
  }
  if (input.checkReferences && input.userCode) {
    for (const match of input.userCode.matchAll(RESOURCE_REF_RE)) {
      const id = match[1];
      if (!declared.has(id)) {
        return `${input.ctx}: userCode references resource "${id}" (via resolveResource/renderResource/getResource) but it is not declared in \`resources\`. Declare it with a real source (mediaId from the project library, or a public URL) — or, if no real image exists, draw that element with SVG/CSS/emoji instead.`;
      }
    }
  }
  return null;
}

// Media entries of the EDITOR library inside project_json — the only id
// namespace motion-clip resources resolve against. Serialized either as a
// record (in-memory shape) or an array.
function parseLibraryMedia(project: Project): Array<{ id: string; name?: string }> {
  if (!project.project_json) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(project.project_json);
  } catch {
    return [];
  }
  const media = (doc as { library?: { media?: unknown } })?.library?.media;
  const entries = Array.isArray(media)
    ? media
    : media && typeof media === "object"
      ? Object.values(media)
      : [];
  const out: Array<{ id: string; name?: string }> = [];
  for (const entry of entries) {
    const m = entry as { id?: string; name?: string; filename?: string };
    if (m?.id) {
      out.push({ id: m.id, name: m.name || m.filename });
    }
  }
  return out;
}

// Backend media ids (add_files, project media) are a DIFFERENT namespace than
// the editor library's ids — the editor silently drops unknown mediaIds and the
// clip persists with an unresolvable resource. Verify against the real library
// up front and hand the LLM the valid ids instead.
async function validateResourceMediaIds(
  apiClient: ApiClient,
  projectId: string,
  entries: Array<{ ctx: string; resources?: ResourceInput[] }>,
): Promise<string | null> {
  const declared = entries.flatMap(({ ctx, resources }) =>
    (resources ?? [])
      .filter((r) => r.type !== "font" && r.mediaId)
      .map((r) => ({ ctx, resource: r })),
  );
  if (declared.length === 0) {
    return null;
  }
  const project = await apiClient.getProject(projectId);
  const media = parseLibraryMedia(project);
  const known = new Set(media.map((m) => m.id));
  for (const { ctx, resource } of declared) {
    if (!known.has(resource.mediaId!)) {
      const available = media.length
        ? `Editor library media ids: ${media.map((m) => `\`${m.id}\`${m.name ? ` (${m.name})` : ""}`).join(", ")}.`
        : "This project's editor library has no media yet.";
      return `${ctx}: resource "${resource.id}" mediaId "${resource.mediaId}" is not in this project's EDITOR library — backend media ids (from add_files / project media) are a different namespace and never resolve in the editor. ${available} Use one of those ids, or pass the image's public URL in blobUrl instead.`;
    }
  }
  return null;
}

const keyframeSchema = z.object({
  time: z.number().describe("Seconds, local to the clip."),
  value: z.union([z.number(), z.array(z.number()), z.string(), z.boolean()]),
  handleIn: z.object({ time: z.number(), value: z.number() }).optional(),
  handleOut: z.object({ time: z.number(), value: z.number() }).optional(),
  hold: z.boolean().optional(),
});

// One operation inside batch_motion_graphics — mirrors the single-op tools.
const batchOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    user_code: z
      .string()
      .min(1)
      .max(MAX_USER_CODE)
      .describe("The motion-clip userCode (see the authoring guide). Boilerplate is appended for you."),
    duration: z.number().gt(0).lte(600).describe("Clip duration in seconds"),
    width: z.number().int().gt(0).lte(4096).optional().describe("Logical width (default 1080)"),
    height: z.number().int().gt(0).lte(4096).optional().describe("Logical height (default 1080)"),
    start_time: z.number().gte(0).optional().describe("Start time on the timeline in seconds"),
    layer_id: z.string().regex(ID_RE).optional().describe("Target layer id; a new layer is created if omitted"),
    name: z.string().max(256).optional(),
    resources: z
      .array(resourceSchema)
      .max(32)
      .optional()
      .describe("REAL media only (mediaId or public URL per image); never invented aliases."),
  }),
  z.object({
    kind: z.literal("update"),
    clip_id: z.string().regex(ID_RE).describe("Motion-graphic clip id"),
    user_code: z.string().min(1).max(MAX_USER_CODE).optional().describe("New userCode. Omit to only change properties."),
    properties: z.record(z.string(), z.unknown()).optional().describe("Property name → new value. Applied after any script change."),
    resources: z.array(resourceSchema).max(32).optional().describe("Replaces the clip's resources when provided"),
  }),
  z.object({
    kind: z.literal("set_keyframes"),
    clip_id: z.string().regex(ID_RE).describe("Motion-graphic clip id"),
    property: z.string().describe("Animatable property name"),
    keyframes: z.array(keyframeSchema).min(1).max(256),
    reset: z.boolean().optional().describe("Replace the property's existing track instead of appending"),
  }),
]);

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

// --- Async mutation jobs (browser-backed; poll via check_edit) ---

// A logical operation inside a motion job. Single-op tools run one; the batch
// tool runs many in the same editor session (one browser launch, one save).
interface MotionJobOp extends MotionOpSpec {
  kind: "create" | "update" | "set_keyframes";
}

// Per-operation outcome persisted on the job (snake_case: it's client-facing).
interface MotionOpOutcome {
  index: number;
  kind: MotionJobOp["kind"];
  label: string;
  ok: boolean;
  clip_id: string | null;
  properties: unknown;
  error: string | null;
}

function projectLink(url: string) {
  return {
    type: "resource_link" as const,
    uri: url,
    name: "Open project",
    mimeType: "text/html",
    description: "Open the Rendley project in the editor",
  };
}

export function formatMotionInProgress(job: Job, label: string) {
  const recent = (job.progress ?? []).slice(-5);
  const progressBlock = recent.length ? `Progress so far:\n${recent.join("\n")}\n\n` : "";
  return {
    content: [
      {
        type: "text" as const,
        text:
          `⏳ ${label} — still running (opening the editor headless takes a bit).\n\n` +
          progressBlock +
          `Call \`check_edit\` with job_id \`${job.job_id}\` — it waits server-side and returns as soon as the job settles; call it again if it still reports in_progress. Do not tell the user it is done until it returns completed/failed.`,
      },
    ],
    structuredContent: { status: "in_progress" as const, job_id: job.job_id },
  };
}

function formatOperationLines(operations: MotionOpOutcome[]): string {
  return operations
    .map((op) => {
      if (op.ok) {
        return `- ✅ [${op.index}] ${op.label}${op.clip_id ? ` — clip \`${op.clip_id}\`` : ""}`;
      }
      return `- ❌ [${op.index}] ${op.label} — ${op.error ?? "failed"}`;
    })
    .join("\n");
}

export function formatMotionResult(job: Job) {
  const result = (job.result ?? {}) as {
    clip_id?: string;
    properties?: unknown;
    operations?: MotionOpOutcome[];
  };
  const operations = result.operations ?? [];
  const failedOps = operations.filter((op) => !op.ok);

  if (job.status === JobStatus.Completed) {
    const url = projectUrl(job.project_id);
    let text: string;
    if (operations.length > 1) {
      text =
        `${failedOps.length === 0 ? "✅" : "⚠️"} ${operations.length - failedOps.length}/${operations.length} operations applied.` +
        (failedOps.length ? " Fix and resubmit ONLY the failed ones (in a new batch)." : "") +
        `\n\n${formatOperationLines(operations)}\n\nOpen project: ${url}`;
    } else {
      text = `✅ Done.${result.clip_id ? ` Clip \`${result.clip_id}\`.` : ""}\n\nOpen project: ${url}`;
    }
    return {
      content: [{ type: "text" as const, text }, projectLink(url)],
      structuredContent: {
        status: "completed" as const,
        job_id: job.job_id,
        clip_id: result.clip_id ?? null,
        properties: result.properties ?? null,
        operations: operations.length ? operations : null,
        failed_count: failedOps.length,
      },
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text:
          `❌ ${job.status}: ${job.error ?? "unknown error"}` +
          (operations.length > 1 ? `\n\n${formatOperationLines(operations)}` : ""),
      },
    ],
    structuredContent: {
      status: job.status,
      job_id: job.job_id,
      error: job.error ?? null,
      operations: operations.length ? operations : null,
    },
  };
}

// Runs the browser-backed ops (one editor session for all of them), mapping the
// outcomes onto the job store. Per-op failures don't fail the job as long as at
// least one op applied — the poller gets the per-op results either way.
async function runMotionJob(
  deps: MotionToolsDeps,
  projectId: string,
  jobId: string,
  ops: MotionJobOp[],
): Promise<void> {
  const logger = log.child({ projectId, jobId, component: "motionJob" });
  await updateJob(jobId, { status: JobStatus.Running });
  try {
    // The per-op callback doubles as a heartbeat: it bumps the job's updated_at
    // so a long batch (N ops × op timeout) isn't falsely marked orphaned.
    const progress: string[] = [];
    const results = await runMotionClipSession(
      {
        apiKey: deps.apiKey,
        projectId,
        save: true,
        onOpDone: (index, r) => {
          progress.push(`${r.ok ? "✓" : "✗"} [${index}] ${ops[index].label}`);
          void updateJob(jobId, { progress: [...progress] }).catch(() => null);
        },
      },
      ops,
    );
    if (results.some((r) => r.error === "__MISSING_MOTION_API__")) {
      await updateJob(jobId, {
        status: JobStatus.Failed,
        error: bridge.motionApiMissingError().message,
        result: { reason: "editor_too_old" },
      });
      return;
    }

    const operations: MotionOpOutcome[] = results.map((r, index) => ({
      index,
      kind: ops[index].kind,
      label: ops[index].label,
      ok: r.ok,
      clip_id: r.clipId ?? null,
      properties: r.properties ?? null,
      error: r.error ?? null,
    }));
    const succeeded = operations.filter((op) => op.ok);

    if (succeeded.length === 0) {
      await updateJob(jobId, {
        status: JobStatus.Failed,
        error:
          operations.length === 1
            ? (operations[0].error ?? "operation failed")
            : `All ${operations.length} operations failed.`,
        result: { reason: "op_failed", operations },
      });
      return;
    }

    logger.info("motion_job_completed", {
      opCount: operations.length,
      failedCount: operations.length - succeeded.length,
    });
    // Keep the flat clip_id/properties for single-op jobs (existing pollers
    // read them); batch consumers read `operations`.
    await updateJob(jobId, {
      status: JobStatus.Completed,
      result: {
        project_id: projectId,
        clip_id: operations.length === 1 ? operations[0].clip_id : null,
        properties: operations.length === 1 ? operations[0].properties : null,
        operations,
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

// Launches through the shared job launcher, behind the per-project run lock
// (max 1, so we never race an edit_video save on the same project). Returns the
// job immediately — the caller polls it via check_edit.
function startMotionJob(deps: MotionToolsDeps, projectId: string, ops: MotionJobOp[]): Promise<Job> {
  return launchQueuedJob({
    prepare: async () => {
      const maxConcurrent = await resolveMcpMaxConcurrent(deps.apiClient);
      const { tenantKey } = resolveKeys(deps.userId, undefined);
      return {
        job: {
          kind: JobKind.MotionGraphic,
          project_id: projectId,
          owner_key_id: deps.apiKeyId,
        },
        slots: [
          { key: tenantKey, max: maxConcurrent },
          { key: `project:${projectId}`, max: 1 },
        ],
      };
    },
    run: (job) => runMotionJob(deps, projectId, job.job_id, ops),
  });
}

// Starts the job, then waits a short grace period inline: fast jobs return
// their FINAL result from the mutation call itself — zero poll calls for the
// LLM, which budgets tool calls per turn. Slow jobs fall back to in_progress +
// job_id for (long-polling) check_edit.
async function startAndAwaitMotionJob(
  deps: MotionToolsDeps,
  projectId: string,
  ops: MotionJobOp[],
  label: string,
) {
  const job = await startMotionJob(deps, projectId, ops);
  const settled = await waitForJob(job.job_id, config.motionStartWaitMs);
  if (settled && isJobTerminal(settled)) {
    return formatMotionResult(settled);
  }
  return formatMotionInProgress(settled ?? job, label);
}

// --- Op builders (shared by the single-op tools and batch_motion_graphics) ---
// All bridge calls run with skipSave — the session flushes ONE save at the end.

interface CreateOpInput {
  script: string;
  duration: number;
  width?: number;
  height?: number;
  start_time?: number;
  layer_id?: string;
  name?: string;
  resources?: BridgeMotionClipResource[];
}

function buildCreateOp(input: CreateOpInput): MotionJobOp {
  return {
    kind: "create",
    label: `create ${input.name ? `"${input.name}"` : "motion graphic"}`,
    run: (page) =>
      bridge.addMotionGraphic(page, {
        script: input.script,
        duration: input.duration,
        width: input.width,
        height: input.height,
        startTime: input.start_time,
        layerId: input.layer_id,
        name: input.name,
        resources: input.resources,
        skipSave: true,
      }),
  };
}

function buildUpdateOp(
  clipId: string,
  script: string | null,
  propEntries: Array<[string, unknown]>,
  resources?: BridgeMotionClipResource[],
): MotionJobOp {
  return {
    kind: "update",
    label: `update ${clipId}`,
    run: async (page) => {
      if (script) {
        const r = await bridge.updateMotionGraphicScript(page, clipId, {
          script,
          resources,
          skipSave: true,
        });
        if (r.error === "__MISSING_MOTION_API__" || !r.ok) return r;
      }
      const failed: string[] = [];
      for (const [name, value] of propEntries) {
        const r = await bridge.setMotionGraphicProperty(page, clipId, name, value, true);
        if (r.error === "__MISSING_MOTION_API__") return r as BridgeMotionGraphicResult;
        if (!r.ok) failed.push(`${name}: ${r.error ?? "failed"}`);
      }
      if (failed.length) {
        return { ok: false, error: `Some properties could not be set: ${failed.join("; ")}` };
      }
      return { ok: true, clipId };
    },
  };
}

function buildKeyframesOp(
  clipId: string,
  property: string,
  keyframes: BridgeMotionKeyframe[],
  reset?: boolean,
): MotionJobOp {
  return {
    kind: "set_keyframes",
    label: `keyframes ${property} on ${clipId}`,
    run: (page) =>
      bridge
        .setMotionGraphicKeyframes(page, clipId, property, keyframes, reset, true)
        .then((r) => ({ ...r, clipId })),
  };
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
                guide.design_guide +
                "\n\n" +
                RESOURCE_CONTRACT_GUIDE,
            },
          ],
          structuredContent: {
            code_rules: guide.code_rules,
            design_guide: guide.design_guide,
            resource_contract: RESOURCE_CONTRACT_GUIDE,
          },
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
        "Create ONE motion-graphic clip from JavaScript you author (userCode: propertyDefines, setProperty, setProperties, draw, svgStringToBase64 — HTML/CSS baked into an SVG foreignObject, drawn with createImageBitmap). Read get_motion_graphics_guide first. The worker boilerplate is appended automatically; do not include it. No Rendley credits are charged. Usually returns the finished result directly; if it returns in_progress with a job_id, call check_edit until completed/failed. Creating several clips (or mixing creates with edits)? Use batch_motion_graphics instead — one editor session for all of them.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project to add the clip to"),
        user_code: z.string().min(1).max(MAX_USER_CODE).describe("The motion-clip userCode (see the authoring guide). Boilerplate is appended for you."),
        duration: z.number().gt(0).lte(600).describe("Clip duration in seconds"),
        width: z.number().int().gt(0).lte(4096).optional().describe("Logical width (default 1080)"),
        height: z.number().int().gt(0).lte(4096).optional().describe("Logical height (default 1080)"),
        start_time: z.number().gte(0).optional().describe("Start time on the timeline in seconds"),
        layer_id: z.string().regex(ID_RE).optional().describe("Target layer id; a new layer is created if omitted"),
        name: z.string().max(256).optional(),
        resources: z.array(resourceSchema).max(32).optional().describe("REAL media only: each image resource needs a mediaId from this project's library or a public URL. Never invent placeholder aliases — draw decorative art in SVG/CSS/emoji instead."),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, user_code, duration, width, height, start_time, layer_id, name, resources }) => {
      try {
        const contractError = validateResourceContract({
          userCode: user_code,
          resources,
          checkReferences: true,
          ctx: "create_motion_graphic",
        });
        if (contractError) return fail(contractError);
        const mediaIdError = await validateResourceMediaIds(apiClient, project_id, [
          { ctx: "create_motion_graphic", resources },
        ]);
        if (mediaIdError) return fail(mediaIdError);
        const script = await apiClient.buildMotionClipScript(user_code);
        const preflightError = await preflightMotionScript({
          script,
          resources: resources as BridgeMotionClipResource[] | undefined,
          duration,
        });
        if (preflightError) return fail(`create_motion_graphic: ${preflightError}`);
        return await startAndAwaitMotionJob(
          deps,
          project_id,
          [
            buildCreateOp({
              script,
              duration,
              width,
              height,
              start_time,
              layer_id,
              name,
              resources: resources as BridgeMotionClipResource[] | undefined,
            }),
          ],
          "Creating motion graphic",
        );
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
        "Update ONE existing motion-graphic clip: replace its script (user_code, boilerplate appended for you) and/or set property values. Get the current user_code with get_motion_graphic first, edit it, and pass it back. No Rendley credits are charged. Usually returns the finished result directly; if it returns in_progress with a job_id, call check_edit until completed/failed. Editing several clips? Use batch_motion_graphics instead — one editor session for all of them.",
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
        const contractError = validateResourceContract({
          userCode: user_code,
          resources,
          checkReferences: resources !== undefined,
          ctx: "update_motion_graphic",
        });
        if (contractError) return fail(contractError);
        const mediaIdError = await validateResourceMediaIds(apiClient, project_id, [
          { ctx: "update_motion_graphic", resources },
        ]);
        if (mediaIdError) return fail(mediaIdError);
        const script = user_code ? await apiClient.buildMotionClipScript(user_code) : null;
        if (script) {
          // Preflight against the clip's effective resources: the provided
          // replacement set, or the existing descriptors when the update keeps them.
          let preflightResources = resources as BridgeMotionClipResource[] | undefined;
          let preflightDuration: number | undefined;
          if (!preflightResources) {
            const project = await apiClient.getProject(project_id);
            const clip = parseMotionClips(project).find((c) => c.id === clip_id);
            preflightResources = clip?.resources as BridgeMotionClipResource[] | undefined;
            preflightDuration = clip?.duration;
          }
          const preflightError = await preflightMotionScript({
            script,
            resources: preflightResources,
            duration: preflightDuration,
          });
          if (preflightError) return fail(`update_motion_graphic: ${preflightError}`);
        }
        const propEntries = properties ? Object.entries(properties) : [];

        return await startAndAwaitMotionJob(
          deps,
          project_id,
          [buildUpdateOp(clip_id, script, propEntries, resources as BridgeMotionClipResource[] | undefined)],
          "Updating motion graphic",
        );
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
        "Animate a motion-graphic clip's property over time with keyframes (bezier easing via handleIn/handleOut, or hold). Animatable properties include the clip's own properties plus position, scale, rotation and alpha. By default keyframes are added to the existing track; pass reset=true to replace it. Usually returns the finished result directly; if it returns in_progress with a job_id, call check_edit until completed/failed.",
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
        return await startAndAwaitMotionJob(
          deps,
          project_id,
          [buildKeyframesOp(clip_id, property, keyframes as BridgeMotionKeyframe[], reset)],
          `Setting keyframes on ${property}`,
        );
      } catch (err) {
        return fail(`Could not set keyframes: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "batch_motion_graphics",
    {
      title: "Batch motion-graphic operations",
      description:
        "Apply several motion-graphic operations (create / update / set_keyframes) to one project in a SINGLE editor session — one browser launch and one save instead of one per clip. STRONGLY PREFERRED whenever you have more than one operation: author all the userCode first (that costs nothing), then submit one batch. Operations run in order and are independent — one failing does not stop the rest; per-operation results come back from check_edit, so you can fix and resubmit only the failed ones. Use per-op start_time/layer_id to place clips. No Rendley credits are charged. Usually returns the finished per-operation results directly; if it returns in_progress with a job_id, call check_edit until completed/failed.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project to apply the operations to"),
        operations: z
          .array(batchOperationSchema)
          .min(1)
          .max(MAX_BATCH_OPERATIONS)
          .describe("Operations applied in order within one editor session"),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, operations }) => {
      try {
        for (const [i, op] of operations.entries()) {
          if (op.kind === "update" && !op.user_code && !op.properties) {
            return fail(`operations[${i}]: nothing to update — provide user_code and/or properties.`);
          }
          if (op.kind === "create" || op.kind === "update") {
            const contractError = validateResourceContract({
              userCode: op.user_code,
              resources: op.resources,
              checkReferences: op.kind === "create" || op.resources !== undefined,
              ctx: `operations[${i}]`,
            });
            if (contractError) return fail(contractError);
          }
        }
        const mediaIdError = await validateResourceMediaIds(
          apiClient,
          project_id,
          operations.map((op, i) => ({
            ctx: `operations[${i}]`,
            resources: op.kind === "set_keyframes" ? undefined : op.resources,
          })),
        );
        if (mediaIdError) return fail(mediaIdError);
        // Assemble + PREFLIGHT all worker scripts up front (the preflight runs
        // each script exactly as the editor's worker would) so a bad op fails
        // here, before a browser is ever launched.
        let projectPromise: Promise<Project> | null = null;
        const fetchProject = () => (projectPromise ??= apiClient.getProject(project_id));
        const ops: MotionJobOp[] = await Promise.all(
          operations.map(async (op, i) => {
            if (op.kind === "create") {
              const script = await apiClient.buildMotionClipScript(op.user_code);
              const preflightError = await preflightMotionScript({
                script,
                resources: op.resources as BridgeMotionClipResource[] | undefined,
                duration: op.duration,
              });
              if (preflightError) {
                throw new Error(`operations[${i}]: ${preflightError}`);
              }
              return buildCreateOp({
                script,
                duration: op.duration,
                width: op.width,
                height: op.height,
                start_time: op.start_time,
                layer_id: op.layer_id,
                name: op.name,
                resources: op.resources as BridgeMotionClipResource[] | undefined,
              });
            }
            if (op.kind === "update") {
              const script = op.user_code ? await apiClient.buildMotionClipScript(op.user_code) : null;
              if (script) {
                let preflightResources = op.resources as BridgeMotionClipResource[] | undefined;
                let preflightDuration: number | undefined;
                if (!preflightResources) {
                  const clip = parseMotionClips(await fetchProject()).find((c) => c.id === op.clip_id);
                  preflightResources = clip?.resources as BridgeMotionClipResource[] | undefined;
                  preflightDuration = clip?.duration;
                }
                const preflightError = await preflightMotionScript({
                  script,
                  resources: preflightResources,
                  duration: preflightDuration,
                });
                if (preflightError) {
                  throw new Error(`operations[${i}]: ${preflightError}`);
                }
              }
              return buildUpdateOp(
                op.clip_id,
                script,
                op.properties ? Object.entries(op.properties) : [],
                op.resources as BridgeMotionClipResource[] | undefined,
              );
            }
            return buildKeyframesOp(op.clip_id, op.property, op.keyframes as BridgeMotionKeyframe[], op.reset);
          }),
        );
        return await startAndAwaitMotionJob(
          deps,
          project_id,
          ops,
          `Applying ${ops.length} motion operation${ops.length === 1 ? "" : "s"}`,
        );
      } catch (err) {
        return fail(`Could not start the batch: ${formatError(err)}`);
      }
    },
  );

}
