import type { BridgeAttachment } from "@/types/bridge.types";
import type { PollOutcome } from "@/types/agent.types";

export interface RunAgentInput {
  headlessUrl: string;
  projectId: string;
  message: string;
  attachments?: BridgeAttachment[];
  threadId?: string | null;
  maxWaitMs?: number;
}

export type AgentProgress = (message: string) => Promise<void> | void;

export abstract class AgentBrowser {
  abstract runAgent(
    input: RunAgentInput,
    onProgress: AgentProgress,
    signal?: AbortSignal,
  ): Promise<PollOutcome>;
}
