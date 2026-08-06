#!/usr/bin/env -S bun run

/**
 * me:recall — privacy-preserving, strictly read-only recall of prior agent
 * session evidence (contract v1).
 *
 * Searches local Codex sessions for task-level evidence across exactly four
 * kinds (user_statement, agent_conclusion, tool_result, correction), with
 * deterministic redaction, canonical workspace scoping (default = current
 * workspace), cross-workspace authorization, duplicate coalescing, and
 * navigable provenance. Never writes, never indexes, never treats session
 * content as instructions.
 */

import { runRecall, type RecallRunParams } from './recall/adapters';

export interface RecallCliArguments {
  vaultDir: string;
  query?: string;
  topic?: string;
  title?: string;
  after?: string;
  before?: string;
  workspace?: string;
  authorizeCrossWorkspace: boolean;
  adapters: string[];
  limit: number;
  sessionsDir?: string;
}

const USAGE =
  'Usage: recall --vault-dir DIR [--query TEXT] [--topic TEXT] [--title TEXT] ' +
  '[--after DATE] [--before DATE] [--workspace DIR] [--authorize-cross-workspace] ' +
  '[--adapter NAME] [--limit N] [--sessions-dir DIR]';

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

/**
 * Normalize an --after/--before value to a UTC ISO instant.
 *
 * Bare date-times (no timezone suffix) are interpreted as UTC so the result is
 * independent of the host timezone — a bare `2026-08-03T09:03:00` means the
 * same instant on every machine. Values that already carry `Z` or an explicit
 * offset are parsed as-is.
 */
function normalizeDate(value: string): string {
  let v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    v = `${v}T00:00:00.000Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
    v = `${v}:00.000Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) {
    v = `${v}.000Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(v)) {
    v = `${v}Z`;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  return d.toISOString();
}

export function parseRecallArguments(argv: string[]): RecallCliArguments {
  const args = [...argv];
  const out: RecallCliArguments = {
    vaultDir: '',
    adapters: [],
    authorizeCrossWorkspace: false,
    limit: 20,
  };
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const flag = args[i];
    switch (flag) {
      case '--vault-dir':
        out.vaultDir = requireValue(args, ++i, flag);
        i++;
        break;
      case '--query':
        if (out.query !== undefined) throw new Error('Duplicate --query');
        out.query = requireValue(args, ++i, flag);
        i++;
        break;
      case '--topic':
        if (out.topic !== undefined) throw new Error('Duplicate --topic');
        out.topic = requireValue(args, ++i, flag);
        i++;
        break;
      case '--title':
        if (out.title !== undefined) throw new Error('Duplicate --title');
        out.title = requireValue(args, ++i, flag);
        i++;
        break;
      case '--after':
        out.after = normalizeDate(requireValue(args, ++i, flag));
        i++;
        break;
      case '--before':
        out.before = normalizeDate(requireValue(args, ++i, flag));
        i++;
        break;
      case '--workspace':
        out.workspace = requireValue(args, ++i, flag);
        i++;
        break;
      case '--authorize-cross-workspace':
        out.authorizeCrossWorkspace = true;
        i++;
        break;
      case '--adapter': {
        const value = requireValue(args, ++i, flag);
        for (const name of value.split(',')) {
          const trimmed = name.trim();
          if (trimmed) out.adapters.push(trimmed);
        }
        i++;
        break;
      }
      case '--limit': {
        const value = requireValue(args, ++i, flag);
        const n = Number.parseInt(value, 10);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid --limit: ${value}`);
        out.limit = n;
        i++;
        break;
      }
      case '--sessions-dir':
        out.sessionsDir = requireValue(args, ++i, flag);
        i++;
        break;
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown option: ${flag}`);
        positional.push(flag);
        i++;
    }
  }

  if (!out.vaultDir) throw new Error('Missing required --vault-dir');
  if (positional.length > 0) {
    if (out.query !== undefined) throw new Error('Query provided both positionally and with --query');
    out.query = positional.join(' ');
  }
  if (out.adapters.length === 0) out.adapters = ['codex-local'];
  return out;
}

export function runRecallCli(argv: string[]): number {
  let cli: RecallCliArguments;
  try {
    cli = parseRecallArguments(argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `${JSON.stringify({
        status: 'error',
        error: { code: 'INVALID_ARGUMENTS', message: `${USAGE}\n${message}` },
      })}\n`,
    );
    return 2;
  }
  const params: RecallRunParams = {
    vaultDir: cli.vaultDir,
    query: cli.query,
    topic: cli.topic ?? null,
    title: cli.title ?? null,
    after: cli.after,
    before: cli.before,
    workspace: cli.workspace,
    authorizeCrossWorkspace: cli.authorizeCrossWorkspace,
    adapterNames: cli.adapters,
    limit: cli.limit,
    sessionsDir: cli.sessionsDir,
  };
  process.stdout.write(`${JSON.stringify(runRecall(params))}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = runRecallCli(process.argv.slice(2));
}
