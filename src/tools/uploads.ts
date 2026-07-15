import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "@/api/client";
import {
  createUploadToken,
  uploadUrlForToken,
  MAX_UPLOAD_BYTES,
  formatMb,
} from "@/http/upload-tokens";
import { fail, formatError, outputAny } from "@/response";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FILES = 25;
const MAX_NAME = 256;
const MAX_MIME = 128;

export function registerUploadTools(server: McpServer, apiClient: ApiClient) {
  server.registerTool(
    "add_files",
    {
      title: "Add files",
      description:
        "Add the user's own local or attached files to a project so edit_video can use them.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project the files belong to"),
        files: z
          .array(
            z.object({
              name: z.string().min(1).max(MAX_NAME).describe("File name, e.g. logo.png"),
              mime_type: z
                .string()
                .min(1)
                .max(MAX_MIME)
                .describe("File type, e.g. image/png, audio/mpeg, video/mp4"),
              size: z
                .number()
                .int()
                .positive()
                .describe("File size in bytes. Used to reject files over the 100 MB limit before uploading."),
            }),
          )
          .min(1)
          .max(MAX_FILES)
          .describe("Files to create upload URLs for"),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ project_id, files }) => {
      try {
        const oversized = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
        const uploads = files
          .filter((f) => f.size <= MAX_UPLOAD_BYTES)
          .map((file) => {
            const mediaId = crypto.randomUUID();
            const token = createUploadToken({
              kind: "project",
              apiClient,
              projectId: project_id,
              mediaId,
              mimeType: file.mime_type,
              fileName: file.name,
            });
            return {
              name: file.name,
              mime_type: file.mime_type,
              media_id: mediaId,
              upload_url: uploadUrlForToken(token),
            };
          });

        const rejected = oversized.map((f) => ({
          name: f.name,
          size: f.size,
          reason: `${formatMb(f.size)}, over the ${formatMb(MAX_UPLOAD_BYTES)} limit`,
        }));

        if (uploads.length === 0) {
          return fail(
            `These files are over the ${formatMb(MAX_UPLOAD_BYTES)} limit and cannot be uploaded here: ` +
              `${rejected.map((r) => `${r.name} (${formatMb(r.size)})`).join(", ")}. ` +
              "Tell the user to add them to the project directly in the editor, or give you a public link to pass to edit_video.",
          );
        }

        const lines = [
          `Created **${uploads.length}** upload URL${uploads.length === 1 ? "" : "s"}.`,
          "",
          "For each file below, PUT its raw bytes to `upload_url` with header `Content-Type: <mime_type>`. Each upload_url is SINGLE-USE — if an upload fails, call add_files again for fresh URLs. The PUT responds with `{ data: { storage_url, media_id } }`. Pass each returned `{ url: storage_url, media_id }` to `edit_video`. No completion call is needed.",
          "",
          "With several files, upload a few in parallel (cap ≈3–4 at once) rather than one long sequential loop — each upload streams the whole file through the server, so a big sequential batch can exceed a single command's time budget. If you still run long, split the uploads across multiple commands.",
          "",
          "```json",
          JSON.stringify(uploads, null, 2),
          "```",
        ];
        if (rejected.length > 0) {
          lines.push(
            "",
            `These files are over the ${formatMb(MAX_UPLOAD_BYTES)} limit and were NOT uploaded: ` +
              `${rejected.map((r) => `${r.name} (${formatMb(r.size)})`).join(", ")}. ` +
              "Tell the user to add them to the project directly in the editor, or give you a public link to pass to edit_video.",
          );
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          structuredContent: { project_id, uploads, rejected },
        };
      } catch (err) {
        return fail(`Could not create uploads: ${formatError(err)}`);
      }
    },
  );
}
