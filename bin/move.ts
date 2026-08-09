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

interface NoteResolution {
  /** Absolute path of the resolved note, or null when unresolved. */
  path: string | null;
  /** Vault-relative candidates when a recursive stem lookup is ambiguous. */
  candidates: string[];
}

/**
 * Recursively collect markdown files under dir, skipping dot-directories
 * such as .obsidian.
 */
function walkMarkdown(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, out);
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
}

/**
 * Resolve a note inside the vault. Accepted input forms, tried in order:
 *
 * 1. Vault-relative path (with or without .md); absolute paths inside the
 *    vault are accepted and converted. Paths escaping the vault are rejected.
 * 2. Path relative to a configured layer root (with or without .md) — this
 *    also covers the classic direct-child lookup.
 * 3. Recursive lookup by bare stem across every configured layer. Multiple
 *    matches yield an ambiguity result listing vault-relative candidates.
 */
function resolveNotePath(vaultDir: string, config: LayerConfig, noteName: string): NoteResolution {
  const none: NoteResolution = { path: null, candidates: [] };
  const cleanName = noteName.replace(/\.md$/, '');
  const layers = Object.values(config);

  const existingFile = (absolute: string): string | null =>
    fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? absolute : null;

  // 1. Vault-relative (or absolute-inside-vault) path.
  if (cleanName.includes('/') || path.isAbsolute(cleanName)) {
    const relative = path.isAbsolute(cleanName)
      ? path.relative(vaultDir, cleanName)
      : cleanName;
    const insideVault = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (insideVault) {
      for (const candidate of [relative, `${relative}.md`]) {
        const hit = existingFile(path.join(vaultDir, candidate));
        if (hit) return { path: hit, candidates: [] };
      }
    }
  }

  // 2. Layer-relative path.
  for (const layer of layers) {
    const layerPath = path.join(vaultDir, layer);
    if (!fs.existsSync(layerPath)) continue;
    for (const candidate of [`${cleanName}.md`, cleanName]) {
      const hit = existingFile(path.join(layerPath, candidate));
      if (hit) return { path: hit, candidates: [] };
    }
  }

  // 3. Recursive stem lookup (bare stems only).
  if (!cleanName.includes('/') && !path.isAbsolute(cleanName)) {
    const matches: string[] = [];
    for (const layer of layers) {
      const layerPath = path.join(vaultDir, layer);
      if (!fs.existsSync(layerPath)) continue;
      const files: string[] = [];
      walkMarkdown(layerPath, files);
      for (const file of files) {
        if (getStem(file) === cleanName) {
          matches.push(file);
        }
      }
    }
    if (matches.length === 1) {
      return { path: matches[0], candidates: [] };
    }
    if (matches.length > 1) {
      return {
        path: null,
        candidates: matches.map((file) => toPosix(path.relative(vaultDir, file))),
      };
    }
  }

  return none;
}

/**
 * Convert a filesystem path to POSIX separators for Obsidian CLI arguments
 * and user-facing messages.
 */
function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

/**
 * Escape a note name before interpolating it into a RegExp.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

          // Rewrite [[oldName]], [[oldName|alias]], and [[oldName#heading]].
          // The note name is escaped before entering the pattern, and the
          // replacement is a function so `$` sequences in newName stay literal.
          const pattern = new RegExp(`\\[\\[${escapeRegExp(oldName)}(\\]|\\||#)`, 'g');
          content = content.replace(pattern, (_match, separator) => `[[${newName}${separator}`);

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
  const resolution = resolveNotePath(vault, config, source);
  if (resolution.candidates.length > 0) {
    return [
      `Error: Note '${source}' is ambiguous — multiple notes share this stem:`,
      ...resolution.candidates.map((candidate) => `  - ${candidate}`),
      'Use a layer-relative or vault-relative path to disambiguate.',
    ].join('\n');
  }
  const sourcePath = resolution.path;
  if (!sourcePath) {
    return `Error: Note '${source}' not found in the vault. Check the name and try again.`;
  }

  const oldName = getStem(sourcePath);
  // Normalized vault-relative source, used for Obsidian CLI arguments.
  const sourceRelative = toPosix(path.relative(vault, sourcePath));

  // Determine operation type
  const isCrossFolder = destination.includes('/') || destination.includes('\\');

  // Expected absolute destination path, used for post-move verification.
  let expectedDestPath: string;

  if (hasObsidian) {
    // Obsidian mode
    try {
      if (isCrossFolder) {
        // Cross-folder move
        execSync(`obsidian move file="${sourceRelative}" to="${destination}"`, { stdio: 'inherit' });
        expectedDestPath = path.join(vault, destination);
      } else {
        // In-place rename
        execSync(`obsidian rename file="${sourceRelative}" name="${destination}"`, { stdio: 'inherit' });
        expectedDestPath = path.join(path.dirname(sourcePath), `${destination}.md`);
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

    expectedDestPath = destPath;

    output.push(`\nMoved: ${source} -> ${destination}`);
    output.push('Wikilinks rewritten via grep+sed.');
    output.push('');
    output.push('Note: Native mode handles [[name]], [[name|alias]], and [[name#heading]] variants.');
  }

  // Verify destination exists
  if (!fs.existsSync(expectedDestPath)) {
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
