import type { BridgeAttachment } from "@/types/bridge.types";
import type { PollOutcome } from "@/types/agent.types";

export interface RunAgentInput {
  headlessUrl: string;
  projectId: string;
  message: string;
  attachments?: BridgeAttachment[];
  threadId?: string | null;
  maxWaitMs?: number;
  // Warm-session reuse hints for the remote browser worker (ignored by the
  // local browser and by old worker builds): a stable tenant+project+thread
  // key and how long to hold the session after a successful run.
  sessionKey?: string;
  holdMs?: number;
}

export type AgentProgress = (message: string) => Promise<void> | void;

export abstract class AgentBrowser {
  abstract runAgent(
    input: RunAgentInput,
    onProgress: AgentProgress,
    signal?: AbortSignal,
  ): Promise<PollOutcome>;
}
