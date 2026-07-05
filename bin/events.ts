#!/usr/bin/env -S bun run
// bin/events.ts — JSONL event logging for me plugin
//
// Exports functions for append and query operations.
// CLI usage:
//   bun run bin/events.ts append --file <path> --type <type> [--subtype <sub>] --description <desc> [--doc-ids id1,id2] [--doc-paths p1,p2]
//   bun run bin/events.ts query --file <path> [--type <type>] [--subtype <sub>] [--doc-id <id>] [--after <date>] [--before <date>] [--limit <n>]

import * as fs from 'fs';
import * as path from 'path';
import { ensureFrontmatterId } from './autolinks.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MeEvent {
  type: string;
  subtype?: string;
  description: string;
  docIds: string[];
  timestamp: string;
}

export interface AppendEventInput {
  type: string;
  subtype?: string;
  description: string;
  docIds?: string[];
}

export interface QueryFilter {
  type?: string;
  subtype?: string;
  docId?: string;
  after?: string;
  before?: string;
  limit?: number;
}

// ── appendEvent ───────────────────────────────────────────────────────────────

export function appendEvent(file: string, event: AppendEventInput): MeEvent {
  const meEvent: MeEvent = {
    type: event.type,
    description: event.description,
    docIds: event.docIds ?? [],
    timestamp: new Date().toISOString(),
  };
  if (event.subtype) {
    meEvent.subtype = event.subtype;
  }

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.appendFileSync(file, JSON.stringify(meEvent) + '\n');
  return meEvent;
}

// ── UUID Resolution ───────────────────────────────────────────────────────────

function readFrontmatterId(filePath: string): string | null {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const fm = content.slice(4, end);
  const match = fm.match(/^id:\s*"?([^"\n]+)"?/m);
  return match ? match[1] : null;
}

export function resolveDocIds(docPaths: string[], cwd: string): string[] {
  const ids: string[] = [];
  for (const relPath of docPaths) {
    const fullPath = path.resolve(cwd, relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found: ${relPath}`);
    }

    let content = fs.readFileSync(fullPath, 'utf8');
    if (!content.startsWith('---\n')) {
      throw new Error(`File has no frontmatter: ${relPath}`);
    }

    let id = readFrontmatterId(fullPath);
    if (!id) {
      const result = ensureFrontmatterId(content);
      if (!result.idAdded) {
        throw new Error(`Cannot add UUID to file: ${relPath}`);
      }
      fs.writeFileSync(fullPath, result.content);
      id = readFrontmatterId(fullPath)!;
    }
    ids.push(id);
  }
  return ids;
}

export function appendEventWithPaths(
  file: string,
  event: Omit<AppendEventInput, 'docIds'>,
  docPaths: string[],
  cwd: string,
): MeEvent {
  const docIds = resolveDocIds(docPaths, cwd);
  return appendEvent(file, { ...event, docIds });
}

// ── queryEvents ───────────────────────────────────────────────────────────────

export function queryEvents(file: string, filter?: QueryFilter): MeEvent[] {
  if (!fs.existsSync(file)) return [];

  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const events: MeEvent[] = [];

  for (const line of lines) {
    let event: MeEvent;
    try {
      event = JSON.parse(line);
    } catch {
      console.error(`Warning: skipping malformed JSON line`);
      continue;
    }

    if (filter?.type && event.type !== filter.type) continue;
    if (filter?.subtype && event.subtype !== filter.subtype) continue;
    if (filter?.docId && !event.docIds.includes(filter.docId)) continue;
    if (filter?.after && event.timestamp < new Date(filter.after).toISOString()) continue;
    if (filter?.before && event.timestamp >= new Date(filter.before + 'T23:59:59.999Z').toISOString()) continue;

    events.push(event);
  }

  if (filter?.limit && filter.limit > 0) {
    return events.slice(-filter.limit);
  }

  return events;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      map.set(args[i].slice(2), args[i + 1]);
      i++;
    }
  }
  return map;
}

function cliAppend(args: string[]) {
  const opts = parseArgs(args);
  const file = opts.get('file');
  const type = opts.get('type');
  const description = opts.get('description');

  if (!file || !type || !description) {
    console.error('Usage: events.ts append --file <path> --type <type> --description <desc> [--subtype <sub>] [--doc-ids id1,id2] [--doc-paths p1,p2]');
    process.exit(1);
  }

  const docIdsStr = opts.get('doc-ids');
  const docPathsStr = opts.get('doc-paths');
  const subtype = opts.get('subtype');

  if (docIdsStr && docPathsStr) {
    console.error('Error: --doc-ids and --doc-paths are mutually exclusive');
    process.exit(1);
  }

  let event: MeEvent;
  if (docPathsStr) {
    const docPaths = docPathsStr.split(',').map(s => s.trim()).filter(Boolean);
    event = appendEventWithPaths(file, { type, subtype, description }, docPaths, process.cwd());
  } else {
    const docIds = docIdsStr ? docIdsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    event = appendEvent(file, { type, subtype, description, docIds });
  }
  console.log(JSON.stringify(event));
}

function cliQuery(args: string[]) {
  const opts = parseArgs(args);
  const file = opts.get('file');

  if (!file) {
    console.error('Usage: events.ts query --file <path> [--type <type>] [--subtype <sub>] [--doc-id <id>] [--after <date>] [--before <date>] [--limit <n>]');
    process.exit(1);
  }

  const filter: QueryFilter = {};
  if (opts.has('type')) filter.type = opts.get('type');
  if (opts.has('subtype')) filter.subtype = opts.get('subtype');
  if (opts.has('doc-id')) filter.docId = opts.get('doc-id');
  if (opts.has('after')) filter.after = opts.get('after');
  if (opts.has('before')) filter.before = opts.get('before');
  if (opts.has('limit')) filter.limit = parseInt(opts.get('limit')!, 10);

  const events = queryEvents(file, filter);
  console.log(JSON.stringify(events));
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const subcommand = process.argv[2];
  if (subcommand === 'append') {
    cliAppend(process.argv.slice(3));
  } else if (subcommand === 'query') {
    cliQuery(process.argv.slice(3));
  } else if (subcommand) {
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
  }
}
