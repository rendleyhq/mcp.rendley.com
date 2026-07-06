import type { ApiClientConfig } from "@/types/api.types";

export type { ApiClientConfig };

export interface VerifiedApiKey {
  keyId: string;
  userId: string;
  permissions: Record<string, string[]> | null;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  workspace_id: string;
  created_by: string;
  fit_duration: number;
  thumbnail_url: string;
  created_at: string;
  updated_at: string;
}

export interface UploadLookupResponse {
  storage_url: string;
  file_hash: string;
  status: string;
  mime_type?: string;
}

export interface BatchUploadBody {
  project_id: string;
  media_id: string;
  file_hash: string;
  file_size: number;
  original_file_name: string;
  mime_type: string;
}

export interface BatchUploadResponse {
  items: Array<{ media_id: string; upload_id: string; presigned_url: string }>;
  rejected?: Array<{ media_id: string; reason: string }>;
}

export interface BatchUploadCompleteResponse {
  failed?: Array<{ upload_id: string; error: string }>;
}

export interface BrandkitColor {
  id: string;
  value: string;
  name?: string;
  /** One of primary | secondary | accent | background | text | neutral. */
  role?: string | null;
}

/** Machine-readable brand voice the AI agent reads to stay on-brand. All fields optional. */
export interface BrandVoice {
  audience?: string;
  tone?: string;
  energy?: string;
  notes?: string;
}

export interface BrandkitProfile {
  id: string;
  workspace_id: string;
  website_url?: string | null;
  summary?: string | null;
  tone?: string | null;
  onboarded: boolean;
  brand_voice: BrandVoice;
}

export interface BrandkitFont {
  id: string;
  font_id: string;
  name: string;
  source: string; // "google" | "brandkit"
  is_pro: boolean;
  role?: string | null;
  order: number;
  source_url?: string;
}

export interface BrandkitTextStyle {
  role: string; // title | subtitle | heading | body | label
  font_id?: string | null;
  font_name?: string | null;
  font_source?: string | null;
  font_weight?: string | null;
  font_size?: number | null;
  line_height?: number | null;
  letter_spacing?: number | null;
  text_case?: string | null; // none | uppercase | lowercase | capitalize
  text_align?: string | null; // left | center | right
  color?: string | null;
  color_role?: string | null;
}

export interface BrandkitTextStyleInput {
  role: string;
  font_id?: string;
  font_weight?: string;
  font_size?: number;
  line_height?: number;
  letter_spacing?: number;
  text_case?: string;
  text_align?: string;
  color?: string;
  color_role?: string;
}

export interface BrandkitVoice {
  id: string;
  model_id: string;
  voice_id: string;
  name?: string | null;
  order: number;
}

export interface BrandkitCaptionStyle {
  config: unknown;
}

export interface BrandkitUpload {
  id: string;
  mime_type: string;
  asset_type: string;
  source_url: string;
  original_file_name: string;
  duration?: number;
  width?: number;
  height?: number;
}

export interface BrandkitOverviewCategory {
  category_id: string;
  category_name: string;
  assets: BrandkitUpload[];
}

export interface BrandkitCreateUploadResult {
  upload_id: string;
  presigned_url: string;
}

export interface ExportJob {
  job_id: string;
}

export interface JobResponse {
  id: string;
  type: string;
  status: "queued" | "processing" | "completed" | "failed" | "canceled";
  input_data: string;
  result_data: string | null;
  error: string | null;
  acknowledged: boolean;
  source_type: string;
  source_id: string;
}

export interface CurrentUser {
  id: string;
  credits: { balance: number };
  subscription?: {
    plan_name: string;
    plan_variant_id: string;
    status: string;
    billing_interval: string;
    projects: number;
    brandkit: boolean;
    workspaces: number;
    storage_bytes: number;
    mcp_agent_max_concurrent: number;
    transcription_seconds: number;
  } | null;
  usage?: {
    projects_used: number;
    workspaces_used: number;
    storage_used: number;
    transcription_seconds_used: number;
  };
  trial?: {
    used: boolean;
    started_at: string | null;
    discount_percent: number;
  };
}

interface VerifyApiKeyResponse {
  valid: boolean;
  key: {
    id: string;
    referenceId: string;
    permissions?: Record<string, string[]> | null;
  } | null;
}

interface EditorTokenResponse {
  token: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly rawBody: string;

  constructor(init: { status: number; code: string; message: string; rawBody: string }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.rawBody = init.rawBody;
  }

  static isApiError(e: unknown): e is ApiError {
    return e instanceof Error && (e as Error).name === "ApiError";
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const rawBody = await res.text().catch(() => "");
  let code = `HTTP_${res.status}`;
  let message = res.statusText || `Request failed with status ${res.status}`;

  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as {
        error?: { code?: string; message?: string };
      };
      if (parsed?.error?.code) code = parsed.error.code;
      if (parsed?.error?.message) message = parsed.error.message;
    } catch {
      const trimmed = rawBody.trim();
      if (trimmed) {
        message = trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
      }
    }
  }

  return new ApiError({ status: res.status, code, message, rawBody });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(private readonly config: ApiClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
  }

  private get headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(this.url(path), {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: {
        ...this.headers,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.request(path);
    const json = (await res.json()) as { data: T };
    return json.data;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.request(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { data: T };
    return json.data;
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.request(path, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { data: T };
    return json.data;
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.request(path, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { data: T };
    return json.data;
  }

  async delete(path: string): Promise<void> {
    await this.request(path, { method: "DELETE" });
  }

  async listWorkspaces(): Promise<Workspace[]> {
    return this.get<Workspace[]>("/workspaces");
  }

  async createWorkspace(input: { name: string }): Promise<Workspace> {
    return this.post<Workspace>("/workspaces", { name: input.name });
  }

  /**
   * Return an existing workspace id, or create one if the user has none.
   * Workspaces are provisioned client-side, so a user reaching the MCP may
   * not have one yet — projects can't exist without a workspace.
   */
  async resolveOrCreateWorkspace(workspaceId?: string): Promise<string> {
    if (workspaceId && workspaceId.trim() !== "") return workspaceId;
    const workspaces = await this.listWorkspaces();
    if (workspaces.length > 0) return workspaces[0].id;
    const workspace = await this.createWorkspace({ name: "My workspace" });
    return workspace.id;
  }

  async listProjects(workspaceId: string): Promise<Project[]> {
    return this.get<Project[]>(
      `/projects?workspace_id=${encodeURIComponent(workspaceId)}`,
    );
  }

  async createProject(input: {
    name: string;
    workspaceId: string;
  }): Promise<Project> {
    return this.post<Project>("/projects", {
      name: input.name,
      workspace_id: input.workspaceId,
    });
  }

  async getProject(projectId: string): Promise<Project> {
    return this.get<Project>(`/projects/${projectId}`);
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.delete(`/projects/${projectId}`);
  }

  async getMe(): Promise<CurrentUser> {
    return this.get<CurrentUser>("/users/me");
  }

  async resolveWorkspaceId(workspaceId?: string): Promise<string> {
    if (workspaceId && workspaceId.trim() !== "") return workspaceId;
    const workspaces = await this.listWorkspaces();
    if (workspaces.length === 0) {
      throw new Error(
        "no workspaces available — create one in the Rendley dashboard first",
      );
    }
    return workspaces[0].id;
  }

  async getBrandkitColors(workspaceId: string): Promise<BrandkitColor[]> {
    return this.get<BrandkitColor[]>(
      `/brandkit/${encodeURIComponent(workspaceId)}/colors`,
    );
  }

  async addBrandkitColor(
    workspaceId: string,
    input: { color: string; name?: string; role?: string },
  ): Promise<BrandkitColor> {
    return this.post<BrandkitColor>(
      `/brandkit/${encodeURIComponent(workspaceId)}/colors`,
      { color: input.color, name: input.name, role: input.role },
    );
  }

  async getBrandkitProfile(workspaceId: string): Promise<BrandkitProfile> {
    return this.get<BrandkitProfile>(
      `/brandkit/${encodeURIComponent(workspaceId)}`,
    );
  }

  async updateBrandVoice(
    workspaceId: string,
    brandVoice: BrandVoice,
  ): Promise<BrandkitProfile> {
    return this.put<BrandkitProfile>(
      `/brandkit/${encodeURIComponent(workspaceId)}/brand-voice`,
      { brand_voice: brandVoice },
    );
  }

  async listBrandkitFonts(workspaceId: string): Promise<BrandkitFont[]> {
    return this.get<BrandkitFont[]>(
      `/brandkit/${encodeURIComponent(workspaceId)}/fonts`,
    );
  }

  async listBrandkitTextStyles(
    workspaceId: string,
  ): Promise<BrandkitTextStyle[]> {
    return this.get<BrandkitTextStyle[]>(
      `/brandkit/${encodeURIComponent(workspaceId)}/text-styles`,
    );
  }

  async upsertBrandkitTextStyle(
    workspaceId: string,
    style: BrandkitTextStyleInput,
  ): Promise<void> {
    await this.put(
      `/brandkit/${encodeURIComponent(workspaceId)}/text-styles`,
      style,
    );
  }

  async getBrandkitCaptionStyle(
    workspaceId: string,
  ): Promise<BrandkitCaptionStyle> {
    return this.get<BrandkitCaptionStyle>(
      `/brandkit/${encodeURIComponent(workspaceId)}/caption-style`,
    );
  }

  async listBrandkitVoices(workspaceId: string): Promise<BrandkitVoice[]> {
    return this.get<BrandkitVoice[]>(
      `/brandkit/${encodeURIComponent(workspaceId)}/voices`,
    );
  }

  async getBrandkitOverview(workspaceId: string): Promise<BrandkitOverviewCategory[]> {
    return this.get<BrandkitOverviewCategory[]>(
      `/brandkit/${encodeURIComponent(workspaceId)}/overview`,
    );
  }

  async createBrandkitUpload(
    workspaceId: string,
    input: {
      assetType: string;
      mimeType: string;
      fileSize: number;
      originalFileName: string;
    },
  ): Promise<BrandkitCreateUploadResult> {
    return this.post<BrandkitCreateUploadResult>(
      `/brandkit/${encodeURIComponent(workspaceId)}/uploads`,
      {
        asset_type: input.assetType,
        mime_type: input.mimeType,
        file_size: input.fileSize,
        original_file_name: input.originalFileName,
      },
    );
  }

  async completeBrandkitUpload(
    workspaceId: string,
    uploadId: string,
  ): Promise<void> {
    await this.post(
      `/brandkit/${encodeURIComponent(workspaceId)}/uploads/complete`,
      { upload_id: uploadId },
    );
  }

  async resolveOrCreateProject(
    projectId: string | undefined,
    opts: { prompt?: string } = {},
  ): Promise<string> {
    if (projectId && projectId.trim() !== "") return projectId;

    const workspaceId = await this.resolveOrCreateWorkspace();

    const name = (opts.prompt ?? "").trim().slice(0, 80) || "Agent job";
    const project = await this.createProject({
      name,
      workspaceId,
    });
    return project.id;
  }

  async createAgentThread(projectId: string): Promise<string> {
    const thread = await this.post<{ ID: string }>("/agent/threads", {
      project_id: projectId,
    });
    return thread.ID;
  }

  async getLastAgentThread(projectId: string): Promise<string | null> {
    const thread = await this.get<{ ID: string } | null>(
      `/agent/threads/last?project_id=${encodeURIComponent(projectId)}`,
    );
    return thread?.ID ?? null;
  }

  async getEditorSessionToken(projectId: string): Promise<string> {
    const res = await fetch(this.url("/auth/session-token"), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ project_id: projectId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`session_token_failed:${res.status}`);
    }
    const body = (await res.json()) as EditorTokenResponse;
    return body.token;
  }

  async createExportJob(input: {
    projectId: string;
    codec?: string;
    targetResolution?: string;
    quality?: string;
  }): Promise<ExportJob> {
    return this.post<ExportJob>("/export", {
      project_id: input.projectId,
      codec: input.codec,
      target_resolution: input.targetResolution,
      quality: input.quality,
    });
  }

  async getJob(jobId: string): Promise<JobResponse> {
    return this.get<JobResponse>(`/jobs/${encodeURIComponent(jobId)}`);
  }

  async lookupUploadByHash(
    projectId: string,
    fileHash: string,
  ): Promise<UploadLookupResponse | null> {
    try {
      return await this.get<UploadLookupResponse>(
        `/uploads?project_id=${encodeURIComponent(projectId)}&hash=${encodeURIComponent(fileHash)}`,
      );
    } catch (err) {
      if (ApiError.isApiError(err) && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  async createBatchUpload(
    projectId: string,
    files: BatchUploadBody[],
  ): Promise<BatchUploadResponse> {
    return this.post<BatchUploadResponse>("/uploads/batch", {
      project_id: projectId,
      files,
    });
  }

  async completeBatchUpload(
    uploadIds: string[],
  ): Promise<BatchUploadCompleteResponse> {
    return this.post<BatchUploadCompleteResponse>("/uploads/batch/complete", {
      upload_ids: uploadIds,
    });
  }

  static async verifyMcpToken(
    authBaseUrl: string,
    token: string,
  ): Promise<{ userId: string } | null> {
    const res = await fetch(`${normalizeBaseUrl(authBaseUrl)}/mcp/get-session`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`mcp_session_verify_failed:${res.status}`);
    }

    const body = (await res.json().catch(() => null)) as
      | { userId?: string; session?: { userId?: string } }
      | null;
    const userId = body?.userId ?? body?.session?.userId ?? null;
    return userId ? { userId } : null;
  }

  static async verifyApiKey(
    baseUrl: string,
    apiKey: string,
  ): Promise<VerifiedApiKey> {
    const res = await fetch(`${normalizeBaseUrl(baseUrl)}/auth/api-key/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: apiKey }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("invalid_api_key");
      }
      throw new Error(`api_key_verify_failed:${res.status}`);
    }

    const payload = (await res.json()) as VerifyApiKeyResponse;
    if (!payload.valid || !payload.key?.referenceId || !payload.key.id) {
      throw new Error("invalid_api_key");
    }

    return {
      keyId: payload.key.id,
      userId: payload.key.referenceId,
      permissions: payload.key.permissions ?? null,
    };
  }
}
