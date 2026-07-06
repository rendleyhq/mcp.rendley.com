import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "@/api/client";
import {
  createUploadToken,
  uploadUrlForToken,
  MAX_UPLOAD_BYTES,
  formatMb,
} from "@/http/upload-tokens";
import {
  assetTypeFromMime,
  uploadBrandAssetFromUrl,
  BRANDKIT_CATEGORIES,
} from "@/brandkit/upload";
import { fail, formatError, outputAny, truncate } from "@/response";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const MAX_FILES = 25;
const MAX_NAME = 256;
const MAX_MIME = 128;

const COLOR_ROLES = [
  "primary",
  "secondary",
  "accent",
  "background",
  "text",
  "neutral",
] as const;
const TEXT_STYLE_ROLES = [
  "title",
  "subtitle",
  "heading",
  "body",
  "label",
] as const;

// Runs a fetch and swallows failures to null, so one unavailable brand-kit
// section never blanks out the rest of the read.
async function settle<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const CATEGORY = z
  .enum(BRANDKIT_CATEGORIES)
  .describe(
    "Which brand kit section to file it under: 'logos' for logo marks, 'fonts' for font files (registers them as a usable brand font — Pro), or 'assets' for everything else (images, video, audio). If omitted, font files go to 'fonts' and everything else to 'assets'; pass 'logos' explicitly for a logo.",
  );

export function registerBrandkitTools(server: McpServer, apiClient: ApiClient) {
  server.registerTool(
    "get_brandkit",
    {
      title: "View brand kit",
      description:
        "Read the workspace's full brand kit: brand voice (tone, audience, energy, notes), colors (with roles), fonts, text styles, caption style, TTS voices, and reusable assets such as logos, images, and music. Use it to stay on-brand — to find brand colors, fonts, or assets to use in edit_video, or to read the current brand voice before writing copy.",
      inputSchema: {
        workspace_id: z
          .string()
          .regex(ID_RE)
          .optional()
          .describe("Optional workspace; defaults to the first one."),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace_id }) => {
      try {
        const wsId = await apiClient.resolveWorkspaceId(workspace_id);
        const [
          profile,
          colors,
          overview,
          fonts,
          textStyles,
          captionStyle,
          voices,
        ] = await Promise.all([
          settle(() => apiClient.getBrandkitProfile(wsId)),
          settle(() => apiClient.getBrandkitColors(wsId)),
          settle(() => apiClient.getBrandkitOverview(wsId)),
          settle(() => apiClient.listBrandkitFonts(wsId)),
          settle(() => apiClient.listBrandkitTextStyles(wsId)),
          settle(() => apiClient.getBrandkitCaptionStyle(wsId)),
          settle(() => apiClient.listBrandkitVoices(wsId)),
        ]);

        const colorList = colors ?? [];
        const overviewList = overview ?? [];
        const fontList = fonts ?? [];
        const styleList = textStyles ?? [];
        const voiceList = voices ?? [];
        const brandVoice = profile?.brand_voice ?? {};
        const hasCaption =
          !!captionStyle?.config &&
          Object.keys(captionStyle.config as object).length > 0;

        const sections: string[] = [];

        const voiceBits = [
          brandVoice.tone && `tone: ${brandVoice.tone}`,
          brandVoice.audience && `audience: ${brandVoice.audience}`,
          brandVoice.energy && `energy: ${brandVoice.energy}`,
          brandVoice.notes && `notes: ${brandVoice.notes}`,
        ].filter(Boolean);
        if (profile?.summary) sections.push(`**Summary:** ${profile.summary}`);
        sections.push(
          voiceBits.length > 0
            ? `**Brand voice:** ${voiceBits.join(" · ")}`
            : "**Brand voice:** not set",
        );

        sections.push(
          colorList.length > 0
            ? `**Colors:** ${colorList
                .map((c) => c.value + (c.role ? ` (${c.role})` : ""))
                .join(", ")}`
            : "**Colors:** none",
        );

        sections.push(
          fontList.length > 0
            ? `**Fonts:** ${fontList
                .map((f) => f.name + (f.role ? ` (${f.role})` : ""))
                .join(", ")}`
            : "**Fonts:** none",
        );

        if (styleList.length > 0) {
          sections.push(
            "**Text styles:** " +
              styleList
                .map(
                  (s) =>
                    `${s.role}${s.font_name ? ` — ${s.font_name}` : ""}${s.font_size ? ` ${s.font_size}px` : ""}`,
                )
                .join(", "),
          );
        }

        if (voiceList.length > 0) {
          sections.push(
            `**Voices:** ${voiceList.map((v) => v.name || v.voice_id).join(", ")}`,
          );
        }

        sections.push(`**Caption style:** ${hasCaption ? "set" : "not set"}`);

        const categoryBlocks = overviewList.map((category) => {
          const head = `**${category.category_name}** (\`${category.category_id}\`): ${category.assets.length} asset${category.assets.length === 1 ? "" : "s"}`;
          if (category.assets.length === 0) return head;
          return (
            head +
            "\n" +
            category.assets
              .map(
                (a) =>
                  `  - ${truncate(a.original_file_name, 40) || "—"}: ${a.source_url}`,
              )
              .join("\n")
          );
        });

        const text = [
          ...sections,
          "",
          "### Assets",
          ...categoryBlocks,
          "",
          `Upload categories: ${overviewList.map((c) => c.category_id).join(", ")}`,
        ].join("\n");

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: {
            workspace_id: wsId,
            website_url: profile?.website_url ?? null,
            summary: profile?.summary ?? null,
            brand_voice: brandVoice,
            categories: overviewList.map((c) => c.category_id),
            colors: colorList.map((c) => ({
              id: c.id,
              value: c.value,
              name: c.name,
              role: c.role ?? null,
            })),
            fonts: fontList.map((f) => ({
              id: f.id,
              font_id: f.font_id,
              name: f.name,
              source: f.source,
              role: f.role ?? null,
            })),
            text_styles: styleList,
            caption_style: hasCaption ? captionStyle?.config : null,
            voices: voiceList.map((v) => ({
              id: v.id,
              model_id: v.model_id,
              voice_id: v.voice_id,
              name: v.name ?? null,
            })),
            assets_by_category: overviewList.map((c) => ({
              category_id: c.category_id,
              category_name: c.category_name,
              assets: c.assets.map((a) => ({
                id: a.id,
                name: a.original_file_name,
                mime_type: a.mime_type,
                url: a.source_url,
              })),
            })),
          },
        };
      } catch (err) {
        return fail(`Could not fetch brand kit: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "add_brand_colors",
    {
      title: "Add brand colors",
      description:
        "Add one or more brand colors (hex, e.g. #FF5A1F) to the workspace brand kit. Each color may carry an optional name and a role (primary, secondary, accent, background, text, neutral) so the agent can pick the right one on-brand. Pass a bare hex string, or an object with hex/name/role. Brand colors are free on all plans.",
      inputSchema: {
        colors: z
          .array(
            z.union([
              z.string().regex(HEX_RE),
              z.object({
                hex: z.string().regex(HEX_RE).describe("Hex color, e.g. #FF5A1F."),
                name: z
                  .string()
                  .max(64)
                  .optional()
                  .describe("Optional label, e.g. 'Brand orange'."),
                role: z
                  .enum(COLOR_ROLES)
                  .optional()
                  .describe("Optional semantic role for this color."),
              }),
            ]),
          )
          .min(1)
          .max(50)
          .describe(
            'Hex strings or objects, e.g. ["#1B1B1B", {"hex":"#FF5A1F","name":"Brand orange","role":"primary"}].',
          ),
        workspace_id: z
          .string()
          .regex(ID_RE)
          .optional()
          .describe("Optional workspace; defaults to the first workspace."),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ colors, workspace_id }) => {
      try {
        const wsId = await apiClient.resolveWorkspaceId(workspace_id);
        const added = [];
        for (const raw of colors) {
          const spec = typeof raw === "string" ? { hex: raw } : raw;
          const value = spec.hex.startsWith("#") ? spec.hex : `#${spec.hex}`;
          added.push(
            await apiClient.addBrandkitColor(wsId, {
              color: value,
              name: typeof raw === "string" ? undefined : raw.name,
              role: typeof raw === "string" ? undefined : raw.role,
            }),
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `Added **${added.length}** color${added.length === 1 ? "" : "s"}: ${added
                .map((c) => c.value + (c.role ? ` (${c.role})` : ""))
                .join(", ")}`,
            },
          ],
          structuredContent: {
            workspace_id: wsId,
            added: added.map((c) => ({
              id: c.id,
              value: c.value,
              name: c.name,
              role: c.role ?? null,
            })),
          },
        };
      } catch (err) {
        return fail(`Could not add brand colors: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "add_brand_assets",
    {
      title: "Add brand assets",
      description:
        "Add assets to the workspace brand kit from the user's local files or from public links — logos, images, video, audio, or font files. Files return an upload_url each to PUT the bytes to; links are fetched and added right away. Uploading a font file (category 'fonts', or a .ttf/.otf/.woff/.woff2 auto-detected) registers it as a brand font usable in text styles. Pass category 'logos' for a logo. The brand kit is a paid feature (custom fonts need Pro); if it isn't available on the user's plan, let them know.",
      inputSchema: {
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
          .max(MAX_FILES)
          .optional()
          .describe("The user's local files. Each returns an upload_url to PUT its bytes to."),
        links: z
          .array(
            z.object({
              url: z.string().url().max(4096).describe("A public https link to the asset."),
              name: z.string().max(256).optional().describe("Optional display name."),
            }),
          )
          .max(MAX_FILES)
          .optional()
          .describe("Assets already hosted at a public URL. Fetched and added right away."),
        category: CATEGORY.optional(),
        workspace_id: z
          .string()
          .regex(ID_RE)
          .optional()
          .describe("Optional workspace; defaults to the first one."),
      },
      outputSchema: outputAny,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ files, links, category, workspace_id }) => {
      if (!files?.length && !links?.length) {
        return fail("Provide files (the user's local files) or links (public URLs) to add to the brand kit.");
      }
      try {
        const wsId = await apiClient.resolveWorkspaceId(workspace_id);

        const addedLinks: string[] = [];
        const linkErrors: string[] = [];
        for (const link of links ?? []) {
          try {
            const result = await uploadBrandAssetFromUrl(apiClient, {
              url: link.url,
              name: link.name,
              category,
              workspaceId: wsId,
            });
            addedLinks.push(result.name);
          } catch (err) {
            linkErrors.push(`${link.name ?? link.url}: ${formatError(err)}`);
          }
        }

        const oversized = (files ?? []).filter((f) => f.size > MAX_UPLOAD_BYTES);
        const uploads = (files ?? [])
          .filter((f) => f.size <= MAX_UPLOAD_BYTES)
          .map((file) => {
            const token = createUploadToken({
              kind: "brandkit",
              apiClient,
              workspaceId: wsId,
              assetType: category ?? assetTypeFromMime(file.mime_type, file.name),
              mimeType: file.mime_type,
              fileName: file.name,
            });
            return { name: file.name, mime_type: file.mime_type, upload_url: uploadUrlForToken(token) };
          });
        const rejected = oversized.map((f) => ({
          name: f.name,
          size: f.size,
          reason: `${formatMb(f.size)}, over the ${formatMb(MAX_UPLOAD_BYTES)} limit`,
        }));

        if (addedLinks.length === 0 && uploads.length === 0) {
          const why = [
            rejected.length
              ? `over the ${formatMb(MAX_UPLOAD_BYTES)} limit: ${rejected.map((r) => `${r.name} (${formatMb(r.size)})`).join(", ")}`
              : "",
            linkErrors.join("; "),
          ]
            .filter(Boolean)
            .join(". ");
          return fail(`No assets were added. ${why}`.trim());
        }

        const lines: string[] = [];
        if (addedLinks.length > 0) {
          lines.push(
            `Added **${addedLinks.length}** asset${addedLinks.length === 1 ? "" : "s"} from links: ${addedLinks.join(", ")}.`,
          );
        }
        if (uploads.length > 0) {
          lines.push(
            "",
            "For EACH file below: PUT its raw bytes to `upload_url` with header `Content-Type: <mime_type>`. On success the asset is added to the brand kit. No completion call is needed.",
            "",
            "```json",
            JSON.stringify(uploads, null, 2),
            "```",
          );
        }
        if (rejected.length > 0) {
          lines.push(
            "",
            `These files are over the ${formatMb(MAX_UPLOAD_BYTES)} limit and were NOT uploaded: ` +
              `${rejected.map((r) => `${r.name} (${formatMb(r.size)})`).join(", ")}. ` +
              "Tell the user to add them in the editor directly, or pass a public link here.",
          );
        }
        if (linkErrors.length > 0) {
          lines.push(
            "",
            `Could not add ${linkErrors.length} link${linkErrors.length === 1 ? "" : "s"}: ${linkErrors.join("; ")}`,
          );
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n").trim() }],
          structuredContent: {
            workspace_id: wsId,
            added_from_links: addedLinks,
            uploads,
            rejected,
            link_errors: linkErrors,
          },
        };
      } catch (err) {
        return fail(`Could not add brand assets: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "set_brand_voice",
    {
      title: "Set brand voice",
      description:
        "Set the workspace's brand voice — the on-brand direction the agent reads before writing any copy, captions, or narration. Provide any of: tone (e.g. 'confident, warm'), audience (who it speaks to), energy (e.g. 'high-energy', 'calm'), and notes (free-form extra direction, read verbatim). Only the fields you pass are updated. Free on all plans.",
      inputSchema: {
        tone: z
          .string()
          .max(500)
          .optional()
          .describe("How the brand sounds, e.g. 'confident, warm, plain-spoken'."),
        audience: z
          .string()
          .max(500)
          .optional()
          .describe("Who the brand speaks to, e.g. 'indie founders shipping fast'."),
        energy: z
          .string()
          .max(500)
          .optional()
          .describe("Overall energy, e.g. 'high-energy' or 'calm and measured'."),
        notes: z
          .string()
          .max(2000)
          .optional()
          .describe("Free-form extra direction, read verbatim by the agent."),
        workspace_id: z
          .string()
          .regex(ID_RE)
          .optional()
          .describe("Optional workspace; defaults to the first one."),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ tone, audience, energy, notes, workspace_id }) => {
      if (
        tone === undefined &&
        audience === undefined &&
        energy === undefined &&
        notes === undefined
      ) {
        return fail("Provide at least one of tone, audience, energy, or notes.");
      }
      try {
        const wsId = await apiClient.resolveWorkspaceId(workspace_id);
        // brand_voice is replaced wholesale; merge onto the current value so
        // callers can update a single field without clearing the others.
        const current =
          (await settle(() => apiClient.getBrandkitProfile(wsId)))?.brand_voice ??
          {};
        const brandVoice = {
          tone: tone ?? current.tone,
          audience: audience ?? current.audience,
          energy: energy ?? current.energy,
          notes: notes ?? current.notes,
        };
        const updated = await apiClient.updateBrandVoice(wsId, brandVoice);
        const v = updated.brand_voice ?? brandVoice;
        const parts = [
          v.tone && `tone: ${v.tone}`,
          v.audience && `audience: ${v.audience}`,
          v.energy && `energy: ${v.energy}`,
          v.notes && `notes: ${v.notes}`,
        ].filter(Boolean);
        return {
          content: [
            {
              type: "text" as const,
              text: `Brand voice updated — ${parts.join(" · ") || "cleared"}.`,
            },
          ],
          structuredContent: { workspace_id: wsId, brand_voice: v },
        };
      } catch (err) {
        return fail(`Could not set brand voice: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "set_brand_text_style",
    {
      title: "Set brand text style",
      description:
        "Create or update the brand text style for one role (title, subtitle, heading, body, or label). Sets typography the editor applies to on-brand text: font (font_id from a brand-kit font in get_brandkit), weight, size in px, line height, letter spacing, case, alignment, and color. Only the fields you pass are set. Free on all plans.",
      inputSchema: {
        role: z
          .enum(TEXT_STYLE_ROLES)
          .describe("Which text role this style applies to."),
        font_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "A brand-kit font id (the `id` of a font from get_brandkit, not font_id).",
          ),
        font_weight: z
          .string()
          .max(32)
          .optional()
          .describe("e.g. '400', '700', 'bold'."),
        font_size: z
          .number()
          .positive()
          .max(2000)
          .optional()
          .describe("Font size in px, applied directly on the clip."),
        line_height: z.number().positive().max(20).optional(),
        letter_spacing: z.number().min(-50).max(200).optional(),
        text_case: z
          .enum(["none", "uppercase", "lowercase", "capitalize"])
          .optional(),
        text_align: z.enum(["left", "center", "right"]).optional(),
        color: z
          .string()
          .regex(HEX_RE)
          .optional()
          .describe("Hex color, e.g. #1B1B1B."),
        color_role: z
          .enum(COLOR_ROLES)
          .optional()
          .describe("Soft reference to a brand color role instead of a fixed hex."),
        workspace_id: z
          .string()
          .regex(ID_RE)
          .optional()
          .describe("Optional workspace; defaults to the first one."),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace_id, color, ...style }) => {
      try {
        const wsId = await apiClient.resolveWorkspaceId(workspace_id);
        await apiClient.upsertBrandkitTextStyle(wsId, {
          ...style,
          color: color ? (color.startsWith("#") ? color : `#${color}`) : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Text style for **${style.role}** saved.`,
            },
          ],
          structuredContent: { workspace_id: wsId, role: style.role },
        };
      } catch (err) {
        return fail(`Could not set text style: ${formatError(err)}`);
      }
    },
  );
}
