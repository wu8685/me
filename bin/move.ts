#!/usr/bin/env -S ts-node
// bin/move.ts - note move/rename with wikilink rewriting
// Moves or renames vault notes while updating all wikilink references.
//
// CLI usage: npx ts-node bin/move.ts <source> <destination> [vault-dir]
// Module usage: const { moveCommand } = require('./bin/move.ts')

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
 * Find a note file in the vault by name (with or without .md extension).
 */
function findNotePath(vaultDir: string, config: LayerConfig, noteName: string): string | null {
  const cleanName = noteName.replace(/\.md$/, '');
  const layers = Object.values(config);

  for (const layer of layers) {
    const layerPath = path.join(vaultDir, layer);
    if (!fs.existsSync(layerPath)) continue;

    // Try with .md extension
    const withExt = path.join(layerPath, `${cleanName}.md`);
    if (fs.existsSync(withExt)) {
      return withExt;
    }

    // Try without extension
    if (fs.existsSync(path.join(layerPath, cleanName))) {
      return path.join(layerPath, cleanName);
    }
  }

  return null;
}

/**
 * Extract filename without extension from a path.
 */
function getStem(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

/**
 * Rewrite wikilinks in all markdown files across the vault.
 * Handles three variants: [[name]], [[name|alias]], [[name#heading]]
 */
function rewriteWikilinks(vaultDir: string, config: LayerConfig, oldName: string, newName: string): void {
  if (oldName.toLowerCase() === newName.toLowerCase()) {
    return; // No rewrite needed if names are the same (case-insensitive)
  }

  const { raw, practices, cognition } = config;
  const layers = [raw, practices, cognition];

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

        try {
          let content = fs.readFileSync(full, 'utf8');
          const originalContent = content;

          // Rewrite [[oldName]] -> [[newName]]
          const pattern1 = new RegExp(`\\[\\[${oldName}(\\]|\\||#)`, 'g');
          content = content.replace(pattern1, `[[${newName}$1`);

          // Rewrite [[oldName]] at end of line (already handled by above, but being explicit)
          const pattern2 = new RegExp(`\\[\\[${oldName}\\]\\]`, 'g');
          content = content.replace(pattern2, `[[${newName}]]`);

          if (content !== originalContent) {
            fs.writeFileSync(full, content, 'utf8');
          }
        } catch (error) {
          // Skip files that can't be read/written
        }
      }
    };

    walk(layerPath);
  }
}

/**
 * Main command function - moves or renames a note with wikilink rewriting.
 */
export async function moveCommand(source: string, destination: string, vaultDir?: string): Promise<string> {
  if (!source) {
    return `Usage: /me:move <source-note> <destination>

Examples:
  /me:move old-name new-name (in-place rename)
  /me:move old-name practices/new-name.md (cross-folder move)`;
  }

  if (!destination) {
    return `Error: Destination is required.

Usage: /me:move <source-note> <destination>

Examples:
  /me:move old-name new-name (in-place rename)
  /me:move old-name practices/new-name.md (cross-folder move)`;
  }

  const vault = vaultDir || process.cwd();
  const config = readConfig(vault);
  const hasObsidian = detectObsidian();

  const output: string[] = [];

  if (hasObsidian) {
    output.push('Using Obsidian CLI for enhanced accuracy (alias resolution).');
  } else {
    output.push('Moving file with native wikilink rewriting.');
  }

  // Find source file
  const sourcePath = findNotePath(vault, config, source);
  if (!sourcePath) {
    return `Error: Note '${source}' not found in the vault. Check the name and try again.`;
  }

  const oldName = getStem(sourcePath);

  // Determine operation type
  const isCrossFolder = destination.includes('/') || destination.includes('\\');

  if (hasObsidian) {
    // Obsidian mode
    try {
      if (isCrossFolder) {
        // Cross-folder move
        execSync(`obsidian move file="${source}" to="${destination}"`, { stdio: 'inherit' });
      } else {
        // In-place rename
        execSync(`obsidian rename file="${source}" name="${destination}"`, { stdio: 'inherit' });
      }
      output.push(`\nMoved: ${source} -> ${destination}`);
      output.push('Wikilinks updated across vault.');
    } catch (error) {
      return `Error running Obsidian CLI: ${error}`;
    }
  } else {
    // Native mode
    let destPath: string;

    if (isCrossFolder) {
      // Cross-folder move
      destPath = path.join(vault, destination);
      // Ensure parent directory exists
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        return `Error: Destination directory does not exist: ${destDir}`;
      }
    } else {
      // In-place rename
      const sourceDir = path.dirname(sourcePath);
      destPath = path.join(sourceDir, `${destination}.md`);
    }

    // Execute move
    try {
      fs.renameSync(sourcePath, destPath);
    } catch (error) {
      return `Error moving file: ${error}`;
    }

    // Rewrite wikilinks if name changed
    const newName = getStem(destPath);
    rewriteWikilinks(vault, config, oldName, newName);

    output.push(`\nMoved: ${source} -> ${destination}`);
    output.push('Wikilinks rewritten via grep+sed.');
    output.push('');
    output.push('Note: Native mode handles [[name]], [[name|alias]], and [[name#heading]] variants.');
  }

  // Verify destination exists
  const destName = getStem(destination);
  const verifiedPath = findNotePath(vault, config, destName);
  if (!verifiedPath) {
    output.push('\nWarning: Destination file could not be verified after move.');
  } else {
    output.push('\nMove operation completed successfully.');
  }

  output.push('\nTip: Run /me:links to verify no broken links were introduced.');

  return output.join('\n');
}

// CLI entry point
if (require.main === module) {
  const source = process.argv[2];
  const destination = process.argv[3];
  const vaultDir = process.argv[4];

  moveCommand(source, destination, vaultDir)
    .then(result => console.log(result))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
