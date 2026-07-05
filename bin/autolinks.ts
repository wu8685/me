#!/usr/bin/env -S bun run
// bin/autolinks.ts - auto-add wikilinks to existing vault notes
// Scans vault files and adds wikilinks by matching content against vault index.
//
// CLI usage: bun run bin/autolinks.ts [vault-dir] [note-path] [layer-filter] [--concepts JSON]
//   - vault-dir: root directory of vault (default: cwd)
//   - note-path: relative path to single note to process (optional, enables single-note mode)
//   - layer-filter: filter to specific layer (optional, e.g., 'raw', 'practices', 'cognition')
//   - --concepts: JSON string of LLM-extracted concepts (optional, enables concept filter mode)
// Module usage: import { autolinkCommand } from './bin/autolinks.ts'

import * as fs from 'fs';
import * as path from 'path';
import { buildVaultIndex, autoLink, resolveConfig, scanExistingWikilinks, extractWikilinkCandidates, VaultEntry } from './ingest.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Concept {
  term: string;
  reasoning: string;
}

export interface AutoLinkOptions {
  vaultDir: string;
  notePath?: string;
  layerFilter?: string;
  concepts?: Concept[];  // LLM-extracted concepts for stub detection
}

interface MergedEntry {
  stem: string;
  title: string;
  source: 'title' | 'wikilink' | 'both';
}

interface AutoLinkStats {
  processed: number;
  linked: number;
  unchanged: number;
  errors: number;
  idsAdded: number;
}

// ── Merged Pool Helpers ────────────────────────────────────────────────────────

/**
 * Build merged pool combining vault titles AND wikilink stems (D-01).
 * This ensures that concepts extracted from existing wikilinks are part of the matching pool.
 */
function buildMergedPool(
  vaultIndex: Map<string, VaultEntry>,
  wikilinkStems: Set<string>,
): Map<string, MergedEntry> {
  const pool = new Map<string, MergedEntry>();

  // Add vault titles
  for (const [key, entry] of vaultIndex) {
    pool.set(key, { stem: entry.stem, title: entry.title, source: 'title' });
  }

  // Add wikilink stems
  for (const stem of wikilinkStems) {
    const key = stem.toLowerCase();
    if (pool.has(key)) {
      pool.get(key)!.source = 'both';
    } else {
      pool.set(key, { stem, title: stem, source: 'wikilink' });
    }
  }

  return pool;
}

/**
 * Convert merged pool to VaultEntry Map for autoLink() compatibility.
 * Wikilink-stem-only entries use empty path (autoLink only needs stem + title).
 */
function poolToVaultIndex(pool: Map<string, MergedEntry>): Map<string, VaultEntry> {
  const index = new Map<string, VaultEntry>();
  for (const [key, entry] of pool) {
    index.set(key, { stem: entry.stem, path: '', title: entry.title });
  }
  return index;
}

// ── Frontmatter ID ─────────────────────────────────────────────────────────────

/**
 * Ensure frontmatter has a UUID id field. If missing, insert one after opening ---.
 * Returns { content, idAdded } — idAdded is false if id already exists or no frontmatter.
 */
export function ensureFrontmatterId(content: string): { content: string; idAdded: boolean } {
  // Must start with frontmatter
  if (!content.startsWith('---\n')) {
    return { content, idAdded: false };
  }

  const secondDelim = content.indexOf('\n---', 4);
  if (secondDelim === -1) {
    return { content, idAdded: false };
  }

  const frontmatter = content.slice(4, secondDelim);

  // Check if id already exists
  if (/^id:\s/m.test(frontmatter)) {
    return { content, idAdded: false };
  }

  const uuid = crypto.randomUUID();
  const newContent = `---\nid: "${uuid}"\n${frontmatter}\n---${content.slice(secondDelim + 4)}`;
  return { content: newContent, idAdded: true };
}

// ── File Discovery ─────────────────────────────────────────────────────────────

/**
 * Find all .md files in configured layer directories.
 * If notePath is provided, returns only that file if it exists.
 */
function findMarkdownFiles(vaultDir: string, notePath?: string, layerFilter?: string): string[] {
  // Single-note mode: return only the specified file
  if (notePath) {
    const fullPath = path.join(vaultDir, notePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${notePath}`);
    }
    if (!notePath.endsWith('.md')) {
      throw new Error(`File must be a .md file: ${notePath}`);
    }
    return [notePath];
  }

  // Bulk mode: find all markdown files in layer directories
  const config = resolveConfig(vaultDir);
  const layerDirs = layerFilter && layerFilter in config
    ? [config[layerFilter as keyof typeof config]]
    : [config.raw, config.practices, config.cognition];

  const files: string[] = [];

  function walkDir(dir: string): void {
    const absDir = path.join(vaultDir, dir);
    if (!fs.existsSync(absDir)) return;

    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walkDir(path.relative(vaultDir, fullPath));
        continue;
      }
      if (entry.name.endsWith('.md')) {
        files.push(path.relative(vaultDir, fullPath));
      }
    }
  }

  for (const layerDir of layerDirs) {
    walkDir(layerDir);
  }

  return files;
}

/**
 * Main command function - auto-adds wikilinks to vault files.
 * @param vaultDir - Vault directory (defaults to cwd)
 * @param notePath - Optional path to single note (relative to vaultDir)
 * @param layerFilter - Optional layer filter ('raw', 'practices', or 'cognition')
 * @param concepts - Optional LLM-extracted concepts (enables concept filter mode)
 */
export async function autolinkCommand(vaultDir?: string, notePath?: string, layerFilter?: string, concepts?: Concept[]): Promise<string> {
  const vault = vaultDir || process.cwd();
  const output: string[] = [];
  const isConceptFilterMode = concepts && concepts.length > 0;

  output.push('## Auto-Link Vault Notes\n');
  output.push(`Vault: ${vault}`);

  // Detect mode
  const isSingleNote = !!notePath;
  if (isSingleNote) {
    output.push(`Mode: Single-note (processing ${notePath})`);
  } else {
    output.push('Mode: Bulk (all vault files)');
  }

  if (layerFilter) {
    output.push(`Layer filter: ${layerFilter}`);
  }

  if (isConceptFilterMode) {
    output.push(`Concept filter: ${concepts!.length} LLM-extracted concepts`);
  }
  output.push('');

  // Scan for existing wikilinks
  output.push('Scanning vault for existing wikilinks...');
  const existingWikilinks = scanExistingWikilinks(vault);
  output.push(`Found ${existingWikilinks.size} existing wikilinks.\n`);

  // Build vault index
  output.push('Building vault index...');
  const vaultIndex = buildVaultIndex(vault);
  output.push(`Indexed ${vaultIndex.size} notes.\n`);

  // Build merged pool (D-01: titles + wikilink stems)
  const mergedPool = buildMergedPool(vaultIndex, existingWikilinks);
  output.push(`Merged pool: ${mergedPool.size} entries (${vaultIndex.size} titles + wikilink stems).\n`);

  // Stage 1: LLM concept stub detection (D-06, D-08)
  let stubs: string[] = [];
  if (isConceptFilterMode) {
    output.push('Processing LLM concepts...');
    for (const concept of concepts!) {
      const key = concept.term.toLowerCase();
      if (!mergedPool.has(key)) {
        stubs.push(concept.term);
      }
    }
    output.push(`LLM concepts: ${concepts!.length}`);
    output.push(`Stubs (not in vault): ${stubs.length}\n`);
  }

  // Stage 2: Deterministic linking with FULL merged pool (D-07: additive)
  const linkingIndex = poolToVaultIndex(mergedPool);

  // Find markdown files (single or bulk)
  const files = findMarkdownFiles(vault, notePath, layerFilter);
  if (isSingleNote) {
    output.push(`Processing: ${notePath}\n`);
  } else {
    output.push(`Found ${files.length} files to process.\n`);
  }

  // Process each file
  const stats: AutoLinkStats = { processed: 0, linked: 0, unchanged: 0, errors: 0, idsAdded: 0 };
  let totalNewLinks = 0;

  for (const file of files) {
    stats.processed++;
    const fullPath = path.join(vault, file);

    try {
      const originalContent = fs.readFileSync(fullPath, 'utf8');

      // Ensure frontmatter has UUID id
      const { content: contentWithId, idAdded } = ensureFrontmatterId(originalContent);
      if (idAdded) stats.idsAdded++;

      const { linkedBody, links } = autoLink(contentWithId, linkingIndex);

      if (linkedBody !== originalContent) {
        fs.writeFileSync(fullPath, linkedBody, 'utf8');
        stats.linked++;
        totalNewLinks += links.length;
        const parts = [`+${links.length} links`];
        if (idAdded) parts.push('+id');
        output.push(`  ✓ ${file} (${parts.join(', ')})`);
      } else {
        stats.unchanged++;
      }
    } catch (error) {
      stats.errors++;
      output.push(`  ✗ ${file}: ${error}`);
    }
  }

  // Summary
  output.push('');
  output.push('## Summary');
  output.push(`Existing wikilinks in vault: ${existingWikilinks.size}`);
  output.push(`New wikilinks inserted: ${totalNewLinks}`);
  output.push(`Total wikilinks after processing: ${existingWikilinks.size + totalNewLinks}`);
  output.push('');
  if (isSingleNote) {
    output.push(`File: ${notePath}`);
  } else {
    output.push(`Processed: ${stats.processed} files`);
  }
  output.push(`Linked: ${stats.linked} files`);
  output.push(`Unchanged: ${stats.unchanged} files`);
  if (stats.idsAdded > 0) {
    output.push(`IDs added: ${stats.idsAdded} files`);
  }
  if (isConceptFilterMode) {
    output.push(`LLM concepts: ${concepts!.length}`);
    output.push(`Merged pool entries: ${mergedPool.size}`);
    output.push(`Stubs (not in vault): ${stubs.length}`);
    if (stubs.length > 0) {
      output.push('');
      output.push('Stubs to consider creating:');
      for (const stub of stubs) {
        output.push(`  - ${stub}`);
      }
    }
  }
  if (stats.errors > 0) {
    output.push(`Errors: ${stats.errors} files`);
  }

  // Suggest potential new wikilinks
  const allContent = files.map(f => fs.readFileSync(path.join(vault, f), 'utf8')).join('\n\n');
  const candidates = extractWikilinkCandidates(allContent, vaultIndex);
  if (candidates.length > 0) {
    output.push('');
    output.push('## Potential new wikilinks to consider:');
    const topCandidates = candidates.slice(0, 5);
    for (const c of topCandidates) {
      output.push(`- [[${c.stem}|${c.title}]] (${c.count} occurrences)`);
    }
  }

  return output.join('\n');
}

// CLI entry point
if (require.main === module) {
  const vaultDir = process.argv[2];
  const arg3 = process.argv[3]; // Could be notePath, layerFilter, or --concepts
  const arg4 = process.argv[4]; // Could be layerFilter, --concepts, or JSON
  const arg5 = process.argv[5]; // Could be --concepts or JSON

  let notePath: string | undefined;
  let layerFilter: string | undefined;
  let concepts: Concept[] | undefined;

  // Parse arguments looking for --concepts flag
  const args = process.argv.slice(2);
  const conceptsIndex = args.indexOf('--concepts');

  if (conceptsIndex !== -1 && conceptsIndex + 1 < args.length) {
    // Parse --concepts JSON
    try {
      const conceptsJson = args[conceptsIndex + 1];
      const parsed = JSON.parse(conceptsJson);
      concepts = parsed.concepts || [];
    } catch (error) {
      console.error('Error: Invalid JSON for --concepts flag');
      process.exit(1);
    }

    // Remove --concepts and its value from args for further parsing
    const remainingArgs = args.filter((_, i) => i !== conceptsIndex && i !== conceptsIndex + 1);

    // Parse remaining args
    if (remainingArgs.length >= 2) {
      const potentialPath = remainingArgs[1];
      if (potentialPath.includes('/') || potentialPath.endsWith('.md')) {
        notePath = potentialPath;
      } else {
        layerFilter = potentialPath;
      }
    }
  } else {
    // No --concepts flag, use original parsing logic
    if (arg3) {
      if (arg3.includes('/') || arg3.endsWith('.md')) {
        notePath = arg3;
        layerFilter = arg4;
      } else {
        layerFilter = arg3;
      }
    }
  }

  autolinkCommand(vaultDir, notePath, layerFilter, concepts)
    .then(result => console.log(result))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
