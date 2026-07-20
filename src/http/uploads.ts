import { ApiError } from "@/api/client";
import {
  consumeUploadToken,
  MAX_UPLOAD_BYTES,
  formatMb,
  type BrandkitUploadContext,
  type ProjectUploadContext,
} from "@/http/upload-tokens";
import { formatError } from "@/response";
import { log } from "@/logger";

const contentHash = (bytes: Uint8Array): string => Bun.hash.xxHash64(bytes, 0n).toString(16);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fail(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

function errorResponse(err: unknown): Response {
  if (ApiError.isApiError(err) && err.status >= 400 && err.status < 500) {
    return fail(err.status, err.code, err.message);
  }
  log.error("stream upload failed", { err });
  return fail(502, "UPLOAD_FAILED", formatError(err));
}

// Uint8Array body forces a fixed Content-Length; S3 rejects chunked PUTs.
async function putToStorage(
  presignedUrl: string,
  bytes: Uint8Array<ArrayBuffer>,
  mimeType: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(presignedUrl, {
    method: "PUT",
    body: bytes,
    signal,
    headers: { "Content-Type": mimeType },
  });
  const body = res.ok ? "" : await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body };
}

export async function handleStreamUpload(req: Request, token: string): Promise<Response> {
  if (req.method !== "PUT") {
    return fail(405, "METHOD_NOT_ALLOWED", "Use HTTP PUT to upload bytes.");
  }

  // Validate before consuming the single-use token, else a bad request burns it.
  const lenHeader = req.headers.get("content-length");
  if (!lenHeader) {
    return fail(411, "LENGTH_REQUIRED", "Content-Length is required.");
  }
  const declared = Number.parseInt(lenHeader, 10);
  if (!Number.isFinite(declared) || declared <= 0) {
    return fail(400, "BAD_CONTENT_LENGTH", "Content-Length must be a positive integer.");
  }
  if (declared > MAX_UPLOAD_BYTES) {
    return fail(413, "FILE_TOO_LARGE", `File exceeds the ${formatMb(MAX_UPLOAD_BYTES)} limit.`);
  }
  if (!req.body) {
    return fail(400, "EMPTY_BODY", "Request body is empty.");
  }

  const ctx = consumeUploadToken(token);
  if (!ctx) {
    return fail(404, "INVALID_UPLOAD_TOKEN", "Upload URL is invalid, already used, or expired. Call add_files again.");
  }

  try {
    const bytes = new Uint8Array(await new Response(req.body).arrayBuffer());
    if (bytes.byteLength === 0) {
      return fail(400, "EMPTY_BODY", "Request body is empty.");
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return fail(413, "FILE_TOO_LARGE", `File exceeds the ${formatMb(MAX_UPLOAD_BYTES)} limit.`);
    }
    return ctx.kind === "project"
      ? await finalizeProject(ctx, bytes, req.signal)
      : await finalizeBrandkit(ctx, bytes, req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}

async function finalizeProject(
  ctx: ProjectUploadContext,
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const fileHash = contentHash(bytes);
  const base = {
    projectId: ctx.projectId,
    mediaId: ctx.mediaId,
    fileName: ctx.fileName,
    mimeType: ctx.mimeType,
    bytes: bytes.byteLength,
    fileHash,
  };
  log.debug("stream upload started", base);

  const created = await ctx.apiClient.createBatchUpload(ctx.projectId, [
    {
      project_id: ctx.projectId,
      media_id: ctx.mediaId,
      file_hash: fileHash,
      file_size: bytes.byteLength,
      original_file_name: ctx.fileName,
      mime_type: ctx.mimeType,
    },
  ]);

  const item = created.items[0];
  if (!item) {
    const reason = created.rejected?.[0]?.reason ?? "no upload slot was created";
    log.warn("stream upload rejected", { ...base, reason });
    return fail(502, "UPLOAD_REJECTED", reason);
  }

  const putRes = await putToStorage(item.presigned_url, bytes, ctx.mimeType, signal);
  if (!putRes.ok) {
    log.error("failed to store stream upload", {
      ...base,
      status: putRes.status,
      storageError: putRes.body.slice(0, 1000),
    });
    return fail(
      502,
      "STORAGE_PUT_FAILED",
      `Storage rejected the upload (HTTP ${putRes.status})${putRes.body ? `: ${putRes.body.slice(0, 200)}` : ""}`,
    );
  }

  const completeRes = await ctx.apiClient.completeBatchUpload([item.upload_id]);
  const failure = completeRes.failed?.find((f) => f.upload_id === item.upload_id);
  if (failure) {
    log.error("failed to complete stream upload", { ...base, uploadId: item.upload_id, error: failure.error });
    return fail(502, "COMPLETE_FAILED", failure.error);
  }

  const lookup = await ctx.apiClient.lookupUploadByHash(ctx.projectId, fileHash);
  if (!lookup?.storage_url) {
    log.error("stream upload storage url missing", base);
    return fail(502, "STORAGE_URL_MISSING", "Upload completed but no storage URL was found.");
  }

  log.info("stream upload completed", { ...base, storageUrl: lookup.storage_url });
  return json(200, { data: { storage_url: lookup.storage_url, media_id: ctx.mediaId } });
}

async function finalizeBrandkit(
  ctx: BrandkitUploadContext,
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const created = await ctx.apiClient.createBrandkitUpload(ctx.workspaceId, {
    assetType: ctx.assetType,
    mimeType: ctx.mimeType,
    fileSize: bytes.byteLength,
    originalFileName: ctx.fileName,
  });

  const putRes = await putToStorage(created.presigned_url, bytes, ctx.mimeType, signal);
  if (!putRes.ok) {
    log.error("failed to store brandkit upload", {
      workspaceId: ctx.workspaceId,
      fileName: ctx.fileName,
      status: putRes.status,
      storageError: putRes.body.slice(0, 1000),
    });
    return fail(
      502,
      "STORAGE_PUT_FAILED",
      `Storage rejected the upload (HTTP ${putRes.status})${putRes.body ? `: ${putRes.body.slice(0, 200)}` : ""}`,
    );
  }

  await ctx.apiClient.completeBrandkitUpload(ctx.workspaceId, created.upload_id);

  return json(200, { data: { upload_id: created.upload_id, workspace_id: ctx.workspaceId } });
}
