import { z } from "zod";
import type { ApiClient } from "@/api/client";
import { uploadBrandAssetFromUrl } from "@/brandkit/upload";
import { UrlGuardError } from "@/utils/url-guard";
import { log } from "@/logger";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const BodySchema = z.object({
  url: z.string().url().max(4096),
  name: z.string().max(256).optional(),
  workspace_id: z.string().regex(ID_RE).optional(),
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleUploadBrandAsset(
  req: Request,
  deps: { apiClient: ApiClient },
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(400, {
      error: { code: "BAD_REQUEST", message: "expected application/json body" },
    });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, {
      error: {
        code: "BAD_REQUEST",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      },
    });
  }

  try {
    const result = await uploadBrandAssetFromUrl(deps.apiClient, {
      url: parsed.data.url,
      name: parsed.data.name,
      workspaceId: parsed.data.workspace_id,
    });
    return json(201, {
      data: {
        workspace_id: result.workspaceId,
        upload_id: result.uploadId,
        name: result.name,
        mime_type: result.mimeType,
      },
    });
  } catch (err) {
    if (err instanceof UrlGuardError) {
      return json(400, { error: { code: err.code.toUpperCase(), message: err.message } });
    }
    log.error("failed to upload brand asset", { err });
    return json(502, {
      error: {
        code: "UPLOAD_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
