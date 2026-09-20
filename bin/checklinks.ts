#!/usr/bin/env -S bun run
// bin/checklinks.ts — deterministic semantic vault link-health reporter

import { buildGraph } from './wikilink-graph.js';
import type { LinkOccurrence } from './wikilink-graph.js';
import * as fs from 'fs';
import * as path from 'path';

interface LayerConfig {
  raw: string;
  practices: string;
  cognition: string;
}

interface VirtualGroup {
  target: string;
  occurrences: number;
  sources: Set<string>;
}

function readConfig(vaultDir: string): LayerConfig {
  const cfgPath = path.join(vaultDir, '.me', 'config.yaml');
  if (!fs.existsSync(cfgPath)) {
    return { raw: 'raw', practices: 'practices', cognition: 'cognition' };
  }
  const text = fs.readFileSync(cfgPath, 'utf8');
  const raw = (text.match(/^\s+raw:\s*["']?([^"'\n]+)["']?/m) || [])[1] || 'raw';
  const practices = (text.match(/^\s+practices:\s*["']?([^"'\n]+)["']?/m) || [])[1] || 'practices';
  const cognition = (text.match(/^\s+cognition:\s*["']?([^"'\n]+)["']?/m) || [])[1] || 'cognition';
  return { raw: raw.trim(), practices: practices.trim(), cognition: cognition.trim() };
}

function isUnderLayer(filePath: string, layerDir: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedLayer = layerDir.replace(/\\/g, '/').replace(/\/$/, '');
  return normalized === normalizedLayer || normalized.startsWith(`${normalizedLayer}/`);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function groupVirtualNodes(nodes: LinkOccurrence[]): VirtualGroup[] {
  const groups = new Map<string, VirtualGroup>();
  for (const node of nodes) {
    let group = groups.get(node.normalizedTarget);
    if (!group) {
      group = { target: node.target, occurrences: 0, sources: new Set<string>() };
      groups.set(node.normalizedTarget, group);
    }
    group.occurrences += 1;
    group.sources.add(node.source);
  }
  return [...groups.values()].sort((a, b) => a.target.localeCompare(b.target));
}

export async function linksCommand(vaultDir?: string, layerFilter?: string): Promise<string> {
  const vault = vaultDir || process.cwd();
  const config = readConfig(vault);
  const graph = buildGraph(vault);
  const output: string[] = ['Using native semantic engine.\n', '## Vault Link Health Report\n'];

  let broken = graph.broken;
  let virtual = graph.virtual;
  let orphans = graph.orphans;
  let deadends = graph.deadends;

  if (layerFilter && layerFilter in config) {
    const layerDir = config[layerFilter as keyof LayerConfig];
    broken = broken.filter(item => isUnderLayer(item.source, layerDir));
    virtual = virtual.filter(item => isUnderLayer(item.source, layerDir));
    orphans = orphans.filter(item => isUnderLayer(item, layerDir));
    deadends = deadends.filter(item => isUnderLayer(item, layerDir));
  }

  output.push(`### Broken Concrete References (${broken.length})`);
  if (broken.length === 0) output.push('None found.');
  else {
    for (const item of broken) {
      output.push(`- ${item.embed ? '!' : ''}[[${item.target}]] referenced from ${item.source}`);
    }
  }
  output.push('');

  const virtualGroups = groupVirtualNodes(virtual);
  output.push(`### Virtual Wikilink Nodes (${virtualGroups.length}) — not errors`);
  if (virtualGroups.length === 0) output.push('None found.');
  else {
    for (const group of virtualGroups) {
      output.push(`- [[${group.target}]] — ${plural(group.occurrences, 'occurrence')}, ${plural(group.sources.size, 'source note')}`);
    }
  }
  output.push('');

  output.push(`### Orphaned Notes (${orphans.length}) — no incoming links`);
  if (orphans.length === 0) output.push('None found.');
  else orphans.forEach(item => output.push(`- ${item}`));
  output.push('');

  output.push(`### Dead-End Notes (${deadends.length}) — no outgoing links`);
  if (deadends.length === 0) output.push('None found.');
  else deadends.forEach(item => output.push(`- ${item}`));
  output.push('');

  output.push(
    `Summary: ${plural(broken.length, 'broken concrete reference')}, ` +
    `${plural(virtualGroups.length, 'virtual node')}, ` +
    `${plural(orphans.length, 'orphan')}, ${plural(deadends.length, 'dead-end')}`
  );
  return output.join('\n');
}

if (require.main === module) {
  const vaultDir = process.argv[2];
  const layerFilter = process.argv[3];
  linksCommand(vaultDir, layerFilter)
    .then(result => console.log(result))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
