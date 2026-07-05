#!/usr/bin/env -S bun run
// bin/search.ts — vault knowledge search
//
// Exports searchCommand() for scripted use.
// CLI usage: bun run bin/search.ts [query] [options] [--vault-dir DIR]

import { resolveConfig } from './ingest.ts';
import { buildGraph } from './wikilink-graph.js';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

interface NoteResult {
  title: string;
  filePath: string;
  stem: string;
  layer: string;
  tags: string[];
  created: string;
  body: string;
}

interface SearchOptions {
  query?: string;
  tags?: string[];
  layer?: string;
  after?: string;
  before?: string;
  linkedTo?: string;
  limit: number;
  vaultDir: string;
}

// ── Help ──────────────────────────────────────────────────────────────────────

const HELP = `Usage: search [query] [options]

Search vault notes by content, tags, layer, date, and wikilink connections.

Options:
  --tags <t1,t2>        Filter by tags (OR within, AND with other flags)
  --layer <name>        Filter by layer (raw|practices|cognition)
  --after <date>        Notes created after date (YYYY-MM-DD or YYYY-MM)
  --before <date>       Notes created before date (YYYY-MM-DD or YYYY-MM)
  --linked-to <note>    Notes containing wikilink to target
  --limit <N>           Max results (default: 20)
  --vault-dir <path>    Vault directory (default: cwd)
  --help                Show this help
`;

// ── Flag Parsing ─────────────────────────────────────────────────────────────

function parseArgs(args: string[], vaultDir: string): SearchOptions {
  const opts: SearchOptions = {
    limit: 20,
    vaultDir,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--tags':
        opts.tags = (args[i + 1] || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        i += 2;
        break;
      case '--layer':
        opts.layer = args[i + 1];
        i += 2;
        break;
      case '--after':
        opts.after = normalizeDate(args[i + 1], 'after');
        i += 2;
        break;
      case '--before':
        opts.before = normalizeDate(args[i + 1], 'before');
        i += 2;
        break;
      case '--linked-to': {
        let target = args[i + 1] || '';
        // Strip [[ and ]] if present
        target = target.replace(/^\[\[/, '').replace(/\]\]$/, '');
        opts.linkedTo = target.toLowerCase();
        i += 2;
        break;
      }
      case '--limit':
        opts.limit = parseInt(args[i + 1], 10) || 20;
        i += 2;
        break;
      case '--vault-dir':
        opts.vaultDir = args[i + 1];
        i += 2;
        break;
      case '--help':
        i++;
        break;
      default:
        // Positional argument — first non-flag arg is the query
        if (!arg.startsWith('--') && opts.query === undefined) {
          opts.query = arg;
        }
        i++;
    }
  }

  return opts;
}

/**
 * Normalize date string.
 * YYYY-MM → YYYY-MM-01 (for --after) or YYYY-MM-31 (for --before)
 * YYYY-MM-DD → return as-is
 */
function normalizeDate(date: string, direction: 'after' | 'before'): string {
  if (!date) return '';
  // YYYY-MM format (no day)
  if (/^\d{4}-\d{2}$/.test(date)) {
    return direction === 'after' ? `${date}-01` : `${date}-31`;
  }
  return date;
}

// ── File Walking ─────────────────────────────────────────────────────────────

function walkDir(dir: string, results: string[]): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, results);
    } else if (entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
}

/**
 * Parse frontmatter and body from a markdown file.
 */
function parseNote(filePath: string, vaultDir: string, layerMap: Map<string, string>): NoteResult | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  // Extract frontmatter (between first and second ---)
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch ? fmMatch[1] : '';
  const bodyStart = fmMatch ? (fmMatch.index! + fmMatch[0].length) : 0;
  const body = content.slice(bodyStart);

  // Extract title
  const titleMatch = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const title = titleMatch ? titleMatch[1].trim().replace(/^["']|["']$/g, '') : '';

  // Extract created
  const createdMatch = frontmatter.match(/^created:\s*(.+)$/m);
  const created = createdMatch ? createdMatch[1].trim() : '';

  // Extract tags
  const tagsMatch = frontmatter.match(/^tags:\s*\[([^\]]*)\]/m);
  const tags: string[] = tagsMatch
    ? tagsMatch[1].split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
    : [];

  // Determine layer by checking which config directory the file path starts with
  const relPath = path.relative(vaultDir, filePath);
  let layer = 'unknown';
  for (const [layerName, layerDir] of layerMap.entries()) {
    if (relPath.startsWith(layerDir + path.sep) || relPath.startsWith(layerDir + '/')) {
      layer = layerName;
      break;
    }
  }

  const stem = path.basename(filePath, '.md');

  return { title, filePath, stem, layer, tags, created, body };
}

// ── Search Filters ────────────────────────────────────────────────────────────

function matchesFilters(note: NoteResult, opts: SearchOptions, linkedToSet?: Set<string>): boolean {
  // Free-text query: case-insensitive match against title OR body
  if (opts.query) {
    const q = opts.query.toLowerCase();
    const titleMatch = note.title.toLowerCase().includes(q);
    const bodyMatch = note.body.toLowerCase().includes(q);
    if (!titleMatch && !bodyMatch) return false;
  }

  // Tags filter (OR within tags)
  if (opts.tags && opts.tags.length > 0) {
    const hasTag = opts.tags.some(tag => note.tags.includes(tag));
    if (!hasTag) return false;
  }

  // Layer filter
  if (opts.layer) {
    if (note.layer !== opts.layer) return false;
  }

  // Date after
  if (opts.after) {
    if (!note.created || note.created < opts.after) return false;
  }

  // Date before
  if (opts.before) {
    if (!note.created || note.created > opts.before) return false;
  }

  // Linked-to filter
  if (opts.linkedTo && linkedToSet) {
    const stem = note.stem.toLowerCase();
    const relPath = path.relative(opts.vaultDir, note.filePath).toLowerCase();
    if (!linkedToSet.has(stem) && !linkedToSet.has(relPath)) return false;
  }

  return true;
}

// ── Output Formatting ─────────────────────────────────────────────────────────

function formatResults(notes: NoteResult[], opts: SearchOptions, total: number): string {
  const lines: string[] = [];
  const activeFilters: string[] = [];

  if (opts.query) activeFilters.push(`query="${opts.query}"`);
  if (opts.tags && opts.tags.length > 0) activeFilters.push(`tags=${opts.tags.join(',')}`);
  if (opts.layer) activeFilters.push(`layer=${opts.layer}`);
  if (opts.after) activeFilters.push(`after=${opts.after}`);
  if (opts.before) activeFilters.push(`before=${opts.before}`);
  if (opts.linkedTo) activeFilters.push(`linked-to=${opts.linkedTo}`);

  if (total === 0) {
    const filterSummary = activeFilters.length > 0 ? ` (${activeFilters.join(', ')})` : '';
    lines.push(`No results found.${filterSummary}`);
    return lines.join('\n');
  }

  const filterSummary = activeFilters.length > 0 ? ` [${activeFilters.join(', ')}]` : '';
  lines.push(`Found ${total} result${total === 1 ? '' : 's'}${filterSummary}`);

  if (total > notes.length) {
    lines.push(`(showing first ${notes.length} of ${total} — use --limit to adjust)`);
  }

  lines.push('');
  lines.push('| Title | Layer | Tags | Created |');
  lines.push('|-------|-------|------|---------|');

  for (const note of notes) {
    const titleLink = `[[${note.stem}|${note.title || note.stem}]]`;
    const tagsStr = note.tags.join(', ');
    lines.push(`| ${titleLink} | ${note.layer} | ${tagsStr} | ${note.created} |`);
  }

  return lines.join('\n');
}

// ── Main Command ───────────────────────────────────────────────────────────────

export async function searchCommand(args: string[], vaultDir?: string): Promise<string> {
  const vault = vaultDir || process.cwd();

  if (args.includes('--help')) {
    return HELP;
  }

  const opts = parseArgs(args, vault);
  opts.vaultDir = vault;

  const config = resolveConfig(vault);

  // Build layer name → directory mapping
  const layerMap = new Map<string, string>([
    ['raw', config.raw],
    ['practices', config.practices],
    ['cognition', config.cognition],
  ]);

  // Collect all .md files from all layer directories
  const allFiles: string[] = [];
  for (const layerDir of [config.raw, config.practices, config.cognition]) {
    const absDir = path.join(vault, layerDir);
    walkDir(absDir, allFiles);
  }

  // Build linked-to set if needed (invert links map)
  let linkedToSet: Set<string> | undefined;
  if (opts.linkedTo) {
    const graph = buildGraph(vault);
    linkedToSet = new Set<string>();
    for (const [source, targets] of Object.entries(graph.links)) {
      for (const target of targets) {
        if (target.toLowerCase() === opts.linkedTo) {
          // source is a relative path like "raw/note-a" — extract stem
          const stem = path.basename(source).replace(/\.md$/, '').toLowerCase();
          linkedToSet.add(stem);
          linkedToSet.add(source.toLowerCase());
        }
      }
    }
  }

  // Parse and filter notes
  const matchingNotes: NoteResult[] = [];
  for (const filePath of allFiles) {
    const note = parseNote(filePath, vault, layerMap);
    if (!note) continue;
    if (matchesFilters(note, opts, linkedToSet)) {
      matchingNotes.push(note);
    }
  }

  // Sort newest-first by created date (string comparison works for ISO dates)
  matchingNotes.sort((a, b) => {
    if (a.created > b.created) return -1;
    if (a.created < b.created) return 1;
    return 0;
  });

  const total = matchingNotes.length;
  const limited = matchingNotes.slice(0, opts.limit);

  return formatResults(limited, opts, total);
}

// ── CLI Entry Point ────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const vaultIdx = args.indexOf('--vault-dir');
  const vaultDir = vaultIdx >= 0 ? args[vaultIdx + 1] : process.cwd();

  if (args.includes('--help')) {
    console.log(HELP);
    process.exit(0);
  }

  searchCommand(args, vaultDir)
    .then(result => console.log(result))
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}
