#!/usr/bin/env -S ts-node
// bin/backlinks.ts - backlink discovery and unlinked mention detection
// Shows incoming wikilinks and unlinked mentions for a target note.
//
// CLI usage: npx ts-node bin/backlinks.ts <note-name> [vault-dir]
// Module usage: const { backlinksCommand } = require('./bin/backlinks.ts')

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
 * Find all files containing the note name as plain text.
 */
function findMentions(vaultDir: string, config: LayerConfig, noteName: string): string[] {
  const mentions: string[] = [];
  const layers = Object.values(config);

  for (const layer of layers) {
    const layerPath = path.join(vaultDir, layer);
    if (!fs.existsSync(layerPath)) continue;

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.md')) continue;

        const content = fs.readFileSync(full, 'utf8');
        // Check if file contains note name (case-insensitive)
        if (content.toLowerCase().includes(noteName.toLowerCase())) {
          const rel = path.relative(vaultDir, full);
          mentions.push(rel);
        }
      }
    };

    walk(layerPath);
  }

  return mentions;
}

/**
 * Main command function - discovers backlinks and unlinked mentions.
 */
export async function backlinksCommand(noteName: string, vaultDir?: string): Promise<string> {
  if (!noteName) {
    return `Usage: /me:backlinks <note-name>

Example: /me:backlinks 2026-04-05-my-note`;
  }

  const vault = vaultDir || process.cwd();
  const config = readConfig(vault);
  const hasObsidian = detectObsidian();
  const cleanNoteName = noteName.replace(/\.md$/, '').toLowerCase();

  const output: string[] = [];

  if (hasObsidian) {
    output.push('Using Obsidian CLI for enhanced accuracy (alias resolution, metadata cache).\n');
  } else {
    output.push('Using native engine.\n');
  }

  output.push(`## Backlinks for [[${noteName.replace(/\.md$/, '')}]]\n`);

  const backlinks: Array<{ file: string; count: number }> = [];
  const unlinkedMentions: string[] = [];

  if (hasObsidian) {
    // Obsidian mode
    try {
      // Existing backlinks
      const backlinkData = execSync(`obsidian backlinks file="${noteName}" counts format=tsv`, { encoding: 'utf8' });
      const lines = backlinkData.trim().split('\n').filter(l => l);
      for (const line of lines) {
        const [file, count] = line.split('\t');
        if (file && count) {
          backlinks.push({ file, count: parseInt(count, 10) });
        }
      }

      // Unlinked mentions
      const searchResults = execSync(`obsidian search query="${noteName}"`, { encoding: 'utf8' });
      const searchLines = searchResults.trim().split('\n').filter(l => l);
      for (const line of searchLines) {
        // Filter out the note itself and already-linked notes
        const cleanLine = line.replace(/^-\s*/, '').trim();
        if (
          cleanLine.toLowerCase() !== cleanNoteName &&
          !backlinks.some(b => b.file.toLowerCase() === cleanLine.toLowerCase())
        ) {
          unlinkedMentions.push(cleanLine);
        }
      }
    } catch (error) {
      output.push(`Error running Obsidian CLI: ${error}\n`);
    }
  } else {
    // Native mode
    const graph = buildGraph(vault);

    // Find backlinks by inverting the links map
    for (const [source, targets] of Object.entries(graph.links)) {
      const linkCount = targets.filter(t => t === cleanNoteName).length;
      if (linkCount > 0) {
        backlinks.push({ file: source, count: linkCount });
      }
    }

    // Find unlinked mentions using grep
    try {
      const { raw, practices, cognition } = config;
      const grepPattern = noteName.replace(/\.md$/, '');
      const grepCmd = `grep -rl "${grepPattern}" "${raw}/" "${practices}/" "${cognition}/" --include="*.md" 2>/dev/null || true`;
      const grepResults = execSync(grepCmd, { encoding: 'utf8', cwd: vault });
      const allMentions = grepResults.trim().split('\n').filter(l => l);

      for (const mention of allMentions) {
        const cleanMention = mention.replace(/^-\s*/, '').trim();
        // Skip if this is the note itself
        if (cleanMention.toLowerCase().endsWith(`${cleanNoteName}.md`)) {
          continue;
        }
        // Skip if already in backlinks
        if (backlinks.some(b => b.file.toLowerCase() === cleanMention.toLowerCase())) {
          continue;
        }
        // Check if it actually contains a wikilink to the note
        const fullPath = path.join(vault, cleanMention);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const hasWikilink = content.match(new RegExp(`\\[\\[${grepPattern}(\\||\\]|#)`, 'i'));
          if (!hasWikilink) {
            unlinkedMentions.push(cleanMention);
          }
        }
      }
    } catch (error) {
      // Grep found no results - that's fine
    }
  }

  // Format output
  output.push(`### Linked (${backlinks.length} notes)`);
  if (backlinks.length > 0) {
    for (const bl of backlinks) {
      output.push(`- [[${bl.file}]] (${bl.count} link${bl.count > 1 ? 's' : ''})`);
    }
  } else {
    output.push('No existing wikilinks found.');
  }
  output.push('');

  output.push(`### Unlinked Mentions (${unlinkedMentions.length} notes) — potential new wikilinks`);
  if (unlinkedMentions.length > 0) {
    for (const mention of unlinkedMentions) {
      // Try to find line number for better UX
      const fullPath = path.join(vault, mention);
      let lineInfo = '';
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        const noteNamePattern = noteName.replace(/\.md$/, '');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(noteNamePattern.toLowerCase())) {
            lineInfo = ` — mentions "${noteNamePattern}" on line ${i + 1}`;
            break;
          }
        }
      }
      output.push(`- ${mention}${lineInfo}`);
    }
  } else {
    output.push('No unlinked mentions found.');
  }
  output.push('');

  if (unlinkedMentions.length > 0) {
    output.push(`Tip: Add [[${noteName.replace(/\.md$/, '')}]] to these notes to create wikilinks.`);
  }

  return output.join('\n');
}

// CLI entry point
if (require.main === module) {
  const noteName = process.argv[2];
  const vaultDir = process.argv[3];

  backlinksCommand(noteName, vaultDir)
    .then(result => console.log(result))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
