import type {
  BridgeMotionClipResource,
  BridgeMotionGraphicInfo,
  BridgeMotionGraphicResult,
  BridgeMotionGraphicSummary,
  BridgeMotionKeyframe,
} from "@/types/bridge.types";

// The wire contract shared with the browser worker's POST /v1/motion-run.
// Keep in sync with rendley-agent-browser-cloudflare src/types.ts.

// A serializable motion operation. `update` is deliberately composite (script +
// properties in one op, fail-fast, aggregated error text) so a wire op maps 1:1
// onto a job operation and behaves exactly like the pre-wire closure did.
export type MotionOp =
  | {
      kind: "create";
      script: string;
      duration: number;
      width?: number;
      height?: number;
      startTime?: number;
      layerId?: string;
      name?: string;
      resources?: BridgeMotionClipResource[];
    }
  | {
      kind: "update";
      clipId: string;
      script?: string | null;
      properties?: Array<{ name: string; value: unknown }>;
      // Only applied together with a script change (matches the editor bridge).
      resources?: BridgeMotionClipResource[];
    }
  | { kind: "set_property"; clipId: string; property: string; value: unknown }
  | {
      kind: "set_keyframes";
      clipId: string;
      property: string;
      keyframes: BridgeMotionKeyframe[];
      reset?: boolean;
    }
  | { kind: "get"; clipId: string }
  | { kind: "list" };

// A rendered frame of the clip, captured after a successful mutation so the
// authoring LLM can SEE the result and self-correct blank/broken output.
export interface MotionFrameCapture {
  // Timeline time of the capture, in seconds.
  time: number;
  // Raw base64 (no data-URI prefix), JPEG.
  jpegBase64: string;
  // Heuristic: a near-uniform image (tiny JPEG) — likely nothing was drawn.
  blank?: boolean;
}

export interface MotionOpResult extends BridgeMotionGraphicResult {
  clip?: BridgeMotionGraphicInfo | null;
  clips?: BridgeMotionGraphicSummary[];
  keyframes?: string;
  frames?: MotionFrameCapture[];
}

export type MotionRunSaveStatus = "synced" | "timeout" | "error" | "skipped";

export interface MotionRunOutcome {
  // Positional, one per op.
  results: MotionOpResult[];
  saved: MotionRunSaveStatus;
}

export interface MotionRunBody {
  headlessUrl: string;
  projectId: string;
  ops: MotionOp[];
  save: boolean;
  maxWaitMs?: number;
}

// NDJSON stream events from POST /v1/motion-run. `op_start` (not progress) is
// the no-re-dispatch trigger: readiness stalls stay retryable, but once op 0
// may have mutated the project a retry could double-apply.
export type MotionWorkerEvent =
  | { type: "progress"; message: string }
  | { type: "op_start"; index: number }
  | { type: "op_done"; index: number; result: MotionOpResult }
  | { type: "ping" }
  | { type: "result"; outcome: MotionRunOutcome }
  | { type: "error"; code: string; message: string; retryAfterSeconds?: number };
