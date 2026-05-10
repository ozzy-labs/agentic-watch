import type { AgentId, Item } from "../schemas/index.js";

export interface ResearchRequest {
  agent: AgentId;
  templateBody: string;
  items: Item[];
  outputPath: string;
}

export interface AgentAdapter {
  id: AgentId;
  research: (req: ResearchRequest) => Promise<void>;
}
