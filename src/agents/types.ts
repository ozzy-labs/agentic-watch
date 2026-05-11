import type { AgentId, Item } from "../schemas/index.js";

export interface ResearchRequest {
  agent: AgentId;
  templateId: string;
  templateBody: string;
  items: Item[];
  outputPath: string;
  /**
   * Working directory for the agent CLI invocation.
   *
   * Adapters spawn the underlying agent CLI as a child process. The agent
   * needs to be rooted at the workspace so it can read `items/`, write
   * `research/`, and resolve relative paths the same way the CLI does.
   */
  cwd: string;
}

export interface AgentAdapter {
  id: AgentId;
  research: (req: ResearchRequest) => Promise<void>;
}
