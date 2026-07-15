import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient, Project } from "@/api/client";
import { fail, formatError, outputAny, table, truncate } from "@/response";
import { log } from "@/logger";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function registerProjectTools(server: McpServer, apiClient: ApiClient) {
  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description: "List the workspaces the user can access.",
      inputSchema: {},
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const workspaces = await apiClient.listWorkspaces();
        if (workspaces.length === 0)
          return {
            content: [{ type: "text" as const, text: "No workspaces." }],
            structuredContent: { workspaces: [] },
          };
        const rows = workspaces.map((w) => [truncate(w.name, 40) || "—"]);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `**${workspaces.length}** workspace${workspaces.length === 1 ? "" : "s"}\n\n` +
                table(["Name"], rows),
            },
          ],
          structuredContent: {
            workspaces: workspaces.map((workspace) => ({
              id: workspace.id,
              name: workspace.name,
            })),
          },
        };
      } catch (err) {
        return fail(`Could not list workspaces: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List the video projects in a workspace, or across all of the user's workspaces if none is given.",
      inputSchema: {
        workspace_id: z
          .string()
          .regex(ID_RE)
          .optional()
          .describe(
            "List only this workspace's projects. Omit to cover all workspaces.",
          ),
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
        let workspaceIds: string[];
        if (workspace_id) {
          workspaceIds = [workspace_id];
        } else {
          const workspaces = await apiClient.listWorkspaces();
          workspaceIds = workspaces.map((w) => w.id);
        }

        const settled = await Promise.allSettled(
          workspaceIds.map((wsId) => apiClient.listProjects(wsId)),
        );
        const all: Project[] = [];
        let failedWorkspaces = 0;
        for (const result of settled) {
          if (result.status === "fulfilled") {
            all.push(...result.value);
          } else {
            failedWorkspaces += 1;
          }
        }
        if (failedWorkspaces > 0) {
          log.warn("list_projects_partial", {
            failedWorkspaces,
            totalWorkspaces: workspaceIds.length,
          });
        }

        if (all.length === 0) {
          if (failedWorkspaces > 0) {
            return fail(
              "Could not list projects — every workspace lookup failed. Please retry.",
            );
          }
          return {
            content: [{ type: "text" as const, text: "No projects found." }],
            structuredContent: { projects: [] },
          };
        }

        const rows = all
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, 50)
          .map((p) => [
            p.id,
            truncate(p.name, 40) || "—",
            `${p.fit_duration.toFixed(1)}s`,
            p.updated_at,
          ]);

        const suffix =
          (all.length > 50 ? `\n\n_…and ${all.length - 50} more_` : "") +
          (failedWorkspaces > 0
            ? `\n\n_⚠️ ${failedWorkspaces} workspace${failedWorkspaces === 1 ? "" : "s"} could not be read; results may be incomplete._`
            : "");
        return {
          content: [
            {
              type: "text" as const,
              text:
                `**${all.length}** project${all.length === 1 ? "" : "s"} (use the project_id column for follow-up calls)\n\n` +
                table(["project_id", "Name", "Duration", "Updated"], rows) +
                suffix,
            },
          ],
          structuredContent: {
            projects: all.map((project) => ({
              id: project.id,
              name: project.name,
              workspace_id: project.workspace_id,
              fit_duration: project.fit_duration,
              created_at: project.created_at,
              updated_at: project.updated_at,
              thumbnail_url: project.thumbnail_url,
            })),
          },
        };
      } catch (err) {
        return fail(`Could not list projects: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description:
        "Create a new video project. Defaults to the user's oldest workspace unless you pass one.",
      inputSchema: {
        name: z.string().min(1).max(256).describe("Name for the project"),
        workspace_id: z
          .string()
          .regex(ID_RE)
          .optional()
          .describe("Optional workspace to create it in."),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, workspace_id }) => {
      try {
        const workspace = await apiClient.resolveWorkspace(workspace_id);

        const project = await apiClient.createProject({
          name,
          workspaceId: workspace.id,
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Created **${project.name}** (project_id: \`${project.id}\`) in workspace **${workspace.name}** (workspace_id: \`${workspace.id}\`).\n\n` +
                "This project_id identifies the project for follow-up calls such as edit_video and export_project. " +
                "If the user's dashboard shows a different workspace, tell them which workspace the project landed in.",
            },
          ],
          structuredContent: {
            project: {
              id: project.id,
              name: project.name,
              workspace_id: workspace.id,
              fit_duration: project.fit_duration,
              created_at: project.created_at,
              updated_at: project.updated_at,
            },
            workspace: { id: workspace.id, name: workspace.name },
          },
        };
      } catch (err) {
        return fail(`Could not create project: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Project details",
      description:
        "Get a single project's details, including its name, duration, and when it was last updated.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project to look up"),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        const project = await apiClient.getProject(project_id);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `**${project.name}** (project_id: \`${project.id}\`)\n` +
                `- duration: ${project.fit_duration.toFixed(1)}s\n` +
                `- updated: ${project.updated_at}`,
            },
          ],
          structuredContent: {
            project: {
              id: project.id,
              name: project.name,
              workspace_id: project.workspace_id,
              fit_duration: project.fit_duration,
              thumbnail_url: project.thumbnail_url,
              created_at: project.created_at,
              updated_at: project.updated_at,
            },
          },
        };
      } catch (err) {
        return fail(`Could not fetch project: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "duplicate_project",
    {
      title: "Duplicate project",
      description:
        "Create a copy of an existing project, including its media assets. Returns the new project's project_id — use that for follow-up calls; the original is left untouched.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project to duplicate"),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        const project = await apiClient.duplicateProject(project_id);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Duplicated into **${project.name}** (project_id: \`${project.id}\`)\n\n` +
                "Use this new project_id for follow-up calls such as edit_video and export_project. The original project is unchanged.",
            },
          ],
          structuredContent: {
            project: {
              id: project.id,
              name: project.name,
              workspace_id: project.workspace_id,
              fit_duration: project.fit_duration,
              thumbnail_url: project.thumbnail_url,
              created_at: project.created_at,
              updated_at: project.updated_at,
            },
          },
        };
      } catch (err) {
        return fail(`Could not duplicate project: ${formatError(err)}`);
      }
    },
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete project",
      description:
        "Permanently delete a project and everything in it. This can't be undone.",
      inputSchema: {
        project_id: z.string().regex(ID_RE).describe("Project to delete"),
      },
      outputSchema: outputAny,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      try {
        await apiClient.deleteProject(project_id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted project \`${project_id}\`.`,
            },
          ],
          structuredContent: { project_id, deleted: true },
        };
      } catch (err) {
        return fail(`Could not delete project: ${formatError(err)}`);
      }
    },
  );
}
