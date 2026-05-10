export interface ResearchTemplate {
  id: string;
  path: string;
  body: string;
}

export async function loadTemplate(_id: string, _dir: string): Promise<ResearchTemplate> {
  throw new Error("loadTemplate: not implemented yet (Phase 1)");
}
