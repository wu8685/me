#!/usr/bin/env -S bun run
// bin/checklink.ts - vault link health reporter
// Reports broken wikilinks, orphaned notes, and dead-end notes across all configured layers.
//
// CLI usage: bun run bin/checklink.ts [vault-dir]
// Module usage: import { linksCommand } from './bin/checklink.ts'

import { buildGraph, LinkGraph } from './wikilink-graph.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface LayerConfig {
  raw: string;
  practices: string;
  cognition: string;
}

/**
 * Read .me/config.yaml from vaultDir and return layer directory mapping.
 * Falls back to defaults (raw, practices, cognition) if config is absent.
 */
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

/**
 * Detect if Obsidian CLI is available.
 */
function detectObsidian(): boolean {
  try {
    execSync('obsidian vault 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file path is under a specific layer directory.
 */
function isUnderLayer(filePath: string, layerDir: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.startsWith(layerDir + '/') || normalized.startsWith(layerDir + '\\');
}

/**
 * Main command function - produces vault link health report.
 */
export async function linksCommand(vaultDir?: string, layerFilter?: string): Promise<string> {
  const vault = vaultDir || process.cwd();
  const config = readConfig(vault);
  const hasObsidian = detectObsidian();

  const output: string[] = [];

  if (hasObsidian) {
    output.push('Using Obsidian CLI for enhanced accuracy (alias resolution, metadata cache).\n');
  } else {
    output.push('Using native engine.\n');
  }

  output.push('## Vault Link Health Report\n');

  if (hasObsidian) {
    // Obsidian mode
    try {
      // Broken wikilinks
      output.push('### Broken Wikilinks');
      const unresolved = execSync('obsidian unresolved verbose format=tsv', { encoding: 'utf8' });
      const lines = unresolved.trim().split('\n').filter(l => l);
      if (lines.length > 0 && lines[0]) {
        const filtered = layerFilter
          ? lines.filter(l => {
              const parts = l.split('\t');
              if (parts.length < 2) return false;
              const source = parts[1];
              return isUnderLayer(source, config[layerFilter as keyof LayerConfig]);
            })
          : lines;
        if (filtered.length > 0) {
          output.push(`(${filtered.length})`);
          for (const line of filtered) {
            const [target, source] = line.split('\t');
            output.push(`- [[${target}]] referenced from ${source}`);
          }
        } else {
          output.push('(0)\nNone found.');
        }
      } else {
        output.push('(0)\nNone found.');
      }
      output.push('');

      // Orphaned notes
      output.push('### Orphaned Notes (N) — no incoming links');
      const orphans = execSync('obsidian orphans', { encoding: 'utf8' });
      const orphanLines = orphans.trim().split('\n').filter(l => l);
      if (orphanLines.length > 0) {
        const filtered = layerFilter
          ? orphanLines.filter(l => isUnderLayer(l, config[layerFilter as keyof LayerConfig]))
          : orphanLines;
        if (filtered.length > 0) {
          output.push(`(${filtered.length})`);
          filtered.forEach(f => output.push(`- ${f}`));
        } else {
          output.push('(0)\nNone found.');
        }
      } else {
        output.push('(0)\nNone found.');
      }
      output.push('');

      // Dead-end notes
      output.push('### Dead-End Notes (N) — no outgoing links');
      const deadends = execSync('obsidian deadends', { encoding: 'utf8' });
      const deadendLines = deadends.trim().split('\n').filter(l => l);
      if (deadendLines.length > 0) {
        const filtered = layerFilter
          ? deadendLines.filter(l => isUnderLayer(l, config[layerFilter as keyof LayerConfig]))
          : deadendLines;
        if (filtered.length > 0) {
          output.push(`(${filtered.length})`);
          filtered.forEach(f => output.push(`- ${f}`));
        } else {
          output.push('(0)\nNone found.');
        }
      } else {
        output.push('(0)\nNone found.');
      }
    } catch (error) {
      output.push(`Error running Obsidian CLI: ${error}`);
    }
  } else {
    // Native mode
    const graph = buildGraph(vault);

    // Filter by layer if specified
    let broken = graph.broken;
    let orphans = graph.orphans;
    let deadends = graph.deadends;

    if (layerFilter && layerFilter in config) {
      const layerDir = config[layerFilter as keyof LayerConfig];
      broken = broken.filter((b: { source: string; target: string }) => isUnderLayer(b.source, layerDir) || isUnderLayer(b.target, layerDir));
      orphans = orphans.filter((o: string) => isUnderLayer(o, layerDir));
      deadends = deadends.filter((d: string) => isUnderLayer(d, layerDir));
    }

    // Broken wikilinks
    output.push(`### Broken Wikilinks (${broken.length})`);
    if (broken.length > 0) {
      broken.forEach((b: { source: string; target: string }) => {
        output.push(`- [[${b.target}]] referenced from ${b.source}`);
      });
    } else {
      output.push('None found.');
    }
    output.push('');

    // Orphaned notes
    output.push(`### Orphaned Notes (${orphans.length}) — no incoming links`);
    if (orphans.length > 0) {
      orphans.forEach((o: string) => output.push(`- ${o}`));
    } else {
      output.push('None found.');
    }
    output.push('');

    // Dead-end notes
    output.push(`### Dead-End Notes (${deadends.length}) — no outgoing links`);
    if (deadends.length > 0) {
      deadends.forEach((d: string) => output.push(`- ${d}`));
    } else {
      output.push('None found.');
    }

    // Summary
    output.push('');
    output.push(`Summary: ${broken.length} broken links, ${orphans.length} orphans, ${deadends.length} dead-ends`);
  }

  return output.join('\n');
}

// CLI entry point
if (require.main === module) {
  const vaultDir = process.argv[2];
  const layerFilter = process.argv[3]; // Optional: 'raw', 'practices', or 'cognition'
  linksCommand(vaultDir, layerFilter)
    .then(result => console.log(result))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
