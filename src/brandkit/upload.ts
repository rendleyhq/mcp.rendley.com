import { basename } from "path";
import type { ApiClient } from "@/api/client";
import { safeFetchMedia } from "@/utils/url-guard";

const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const ASSET_FETCH_TIMEOUT_MS = 30_000;

// The brand kit accepts exactly these upload categories (api IsValidBrandkitCategory); anything
// else is rejected with a 400. "logos" can't be inferred from a MIME type, so it must be passed
// explicitly; everything non-font falls into the general "assets" bucket.
export const BRANDKIT_CATEGORIES = ["logos", "fonts", "assets"] as const;
export type BrandkitCategory = (typeof BRANDKIT_CATEGORIES)[number];

const FONT_MIME_RE =
  /^(font\/|application\/(x-font-|font-|vnd\.ms-fontobject))/;
const FONT_EXT_RE = /\.(ttf|otf|woff2?|eot)$/i;

// Uploading a font file (category "fonts") registers it as a brand font on completion.
export function isFontAsset(mime: string, fileName?: string): boolean {
  return FONT_MIME_RE.test(mime.toLowerCase()) || (!!fileName && FONT_EXT_RE.test(fileName));
}

export function assetTypeFromMime(mime: string, fileName?: string): BrandkitCategory {
  return isFontAsset(mime, fileName) ? "fonts" : "assets";
}

export interface UploadBrandAssetResult {
  workspaceId: string;
  uploadId: string;
  name: string;
  mimeType: string;
}

export async function uploadBrandAssetFromUrl(
  apiClient: ApiClient,
  input: { url: string; name?: string; workspaceId?: string; category?: string },
): Promise<UploadBrandAssetResult> {
  const workspaceId = await apiClient.resolveWorkspaceId(input.workspaceId);

  const fetched = await safeFetchMedia(input.url, {
    maxBytes: MAX_ASSET_BYTES,
    timeoutMs: ASSET_FETCH_TIMEOUT_MS,
  });
  const mimeType =
    fetched.contentType.split(";")[0].trim() || "application/octet-stream";
  const name =
    input.name?.trim() || basename(new URL(input.url).pathname) || "asset";

  const created = await apiClient.createBrandkitUpload(workspaceId, {
    assetType: input.category ?? assetTypeFromMime(mimeType, name),
    mimeType,
    fileSize: fetched.size,
    originalFileName: name,
  });

  const put = await fetch(created.presigned_url, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    // Buffer is a valid fetch body at runtime; cast around lib type mismatch.
    body: fetched.body as unknown as BodyInit,
  });
  if (!put.ok) {
    throw new Error(`storage_put_failed:${put.status}`);
  }

  await apiClient.completeBrandkitUpload(workspaceId, created.upload_id);

  return { workspaceId, uploadId: created.upload_id, name, mimeType };
}
