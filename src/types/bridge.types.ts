export interface BridgeAttachment {
  media_id?: string;
  storage_url?: string;
  name?: string;
}

export interface BridgeMessage {
  role: "user" | "assistant" | "system";
  content: string;
  error?: string;
}

export enum BridgeRunStatus {
  Idle = "idle",
  Running = "running",
  Completed = "completed",
  Error = "error",
  Cancelled = "cancelled",
}

export interface BridgeStatus {
  isStreaming: boolean;
  hasInterrupt: boolean;
  interruptType: BridgeInterruptType | null;
  interruptId: string | null;
  messageCount: number;
  isSyncing: boolean;
  commandExecutions: number;
  lastError?: string | null;
  // Deterministic run lifecycle (bridge v2). Older editor builds omit it —
  // pollers must fall back to the idle heuristic when undefined.
  lastRunStatus?: BridgeRunStatus;
}

export enum BridgeInterruptType {
  PlanReview = "plan_review",
  RequestUpgrade = "request_upgrade",
  ToolReview = "tool_review",
  ContextRequest = "context_request",
  CommandExecution = "command_execution",
}

export interface BridgeExportConfig {
  codec?: "h264" | "h265" | "vp9" | "vp8";
  targetResolution?: "720p" | "1080p" | "4K";
  quality?: "high" | "medium" | "low";
  bitrate?: number;
}

export interface BridgeExportResult {
  status: "ok" | "empty" | "error";
  size?: number;
  mimeType?: string;
  extension?: string;
  storageUrl?: string;
  fileHash?: string;
  mediaId?: string;
  uploadId?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  error?: string;
  errorCode?: string;
}

export type FlushSaveResult = { status: "synced" | "timeout" | "error" };

// --- Motion graphics (direct MotionClip control, no agent) ---

export interface BridgeMotionClipResource {
  id: string;
  type?: string;
  label?: string;
  mediaId?: string;
  blobUrl?: string;
  grabUrl?: string;
  fit?: "cover" | "contain" | "fill" | "none" | "scale-down";
  offsetX?: number;
  offsetY?: number;
  family?: string;
  css?: string;
}

export interface BridgeMotionClipProperty {
  name: string;
  type: string;
  value: unknown;
}

export interface BridgeOpResult {
  ok: boolean;
  error?: string;
}

export interface BridgeMotionGraphicResult extends BridgeOpResult {
  clipId?: string;
  properties?: BridgeMotionClipProperty[];
}

export interface BridgeMotionGraphicInfo {
  clipId: string;
  name: string;
  script: string;
  properties: BridgeMotionClipProperty[];
  resources: BridgeMotionClipResource[];
  width: number;
  height: number;
  duration: number;
  startTime: number;
}

export interface BridgeMotionGraphicSummary {
  clipId: string;
  name: string;
  startTime: number;
  duration: number;
}

export interface BridgeMotionKeyframe {
  time: number;
  value: number | number[] | string | boolean;
  handleIn?: { time: number; value: number };
  handleOut?: { time: number; value: number };
  hold?: boolean;
}

export interface BridgeAddMotionGraphicOptions {
  script: string;
  duration: number;
  width?: number;
  height?: number;
  startTime?: number;
  layerId?: string;
  name?: string;
  resources?: BridgeMotionClipResource[];
  // Skip the editor's per-op save; the session flushes one save at the end.
  // Older editor builds ignore it and save per-op (harmless, just slower).
  skipSave?: boolean;
}

export interface RendleyAgentWindowApi {
  sendMessage: (
    message: string,
    attachments?: BridgeAttachment[],
  ) => Promise<void>;
  getStatus: () => BridgeStatus;
  getMessages: () => BridgeMessage[];
  resumeInterrupt: (response: "approve" | "reject") => Promise<void>;
  ensureSaved: (timeoutMs?: number) => Promise<FlushSaveResult>;
  // Bridge v2: direct save awaiting the actual PATCH. Optional on older builds.
  saveNow?: (timeoutMs?: number) => Promise<FlushSaveResult>;
  exportProject: (config?: BridgeExportConfig) => Promise<BridgeExportResult>;
  // Motion graphics — direct MotionClip control (optional: only newer editor
  // builds expose them; wrappers guard and surface a clear error if absent).
  addMotionGraphic?: (
    options: BridgeAddMotionGraphicOptions,
  ) => Promise<BridgeMotionGraphicResult>;
  updateMotionGraphicScript?: (
    clipId: string,
    options: { script: string; resources?: BridgeMotionClipResource[]; skipSave?: boolean },
  ) => Promise<BridgeMotionGraphicResult>;
  setMotionGraphicProperty?: (
    clipId: string,
    property: string,
    value: unknown,
    skipSave?: boolean,
  ) => Promise<BridgeOpResult>;
  getMotionGraphic?: (clipId: string) => Promise<BridgeMotionGraphicInfo | null>;
  listMotionGraphics?: () => BridgeMotionGraphicSummary[];
  setMotionGraphicKeyframes?: (
    clipId: string,
    property: string,
    keyframes: BridgeMotionKeyframe[],
    reset?: boolean,
    skipSave?: boolean,
  ) => Promise<BridgeOpResult>;
  getMotionGraphicKeyframes?: (clipId: string) => Promise<string>;
}

declare global {
  interface Window {
    __rendleyAgent?: RendleyAgentWindowApi;
    __rendleyEditorReady?: boolean;
  }
}
