import { config } from "@/config";
import { log } from "@/logger";
import { AgentBrowser, type RunAgentInput, type AgentProgress } from "@/sdk/agent-browser";
import { acquireEditorPage, releasePage } from "@/sdk/session";
import { bridge } from "@/bridge/index";
import { pollAgentCore } from "@/agent/poll";
import type { PollOutcome } from "@/types/agent.types";

export class LocalAgentBrowser extends AgentBrowser {
  async runAgent(
    input: RunAgentInput,
    onProgress: AgentProgress,
    signal?: AbortSignal,
  ): Promise<PollOutcome> {
    void signal;
    const logger = log.child({ projectId: input.projectId, component: "local_agent" });
    await onProgress("Opening editor");
    const page = await acquireEditorPage(input.headlessUrl, input.projectId);
    try {
      await onProgress("Sending message to agent");
      await bridge.sendMessage(
        page,
        input.message,
        input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
      );
      return await pollAgentCore({
        page,
        projectId: input.projectId,
        release: releasePage,
        threadId: input.threadId ?? null,
        maxWaitMs: input.maxWaitMs ?? config.agentTimeoutMs,
        autoApprove: true,
        logger,
        onProgress,
      });
    } catch (err) {
      await releasePage(page).catch(() => {});
      throw err;
    }
  }
}
