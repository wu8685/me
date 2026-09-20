export interface LinkOccurrence {
  source: string;
  target: string;
  normalizedTarget: string;
  embed: boolean;
}

export interface LinkGraph {
  files: string[];
  links: { [key: string]: string[] };
  broken: LinkOccurrence[];
  virtual: LinkOccurrence[];
  ignored: LinkOccurrence[];
  orphans: string[];
  deadends: string[];
}

export function buildGraph(vaultDir: string): LinkGraph;
