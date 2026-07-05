// Type definitions for wikilink-graph.js

export interface LinkGraph {
  files: string[];
  links: { [key: string]: string[] };
  broken: Array<{ source: string; target: string }>;
  orphans: string[];
  deadends: string[];
}

export function buildGraph(vaultDir: string): LinkGraph;
