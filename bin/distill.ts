#!/usr/bin/env -S bun run

/**
 * me:distill — evidence-gated Practice→Cognition promotion.
 *
 * Evaluates a practice note against deterministic gates, produces an
 * exact-preview with digest for confirmation, and writes cognition notes
 * via the shared vault-write transaction executor under lock.
 *
 * Safety: never auto-promotes; never deletes/demotes Practices; no status/
 * lifecycle frontmatter; same-task/copied/child agents are not independent;
 * PR merge/praise is not evidence or authorization.
 */

import {
  DistillError,
  DISTILL_ERROR_CODES,
  type DistillResultV1,
} from './distill/contracts';
import {
  runDistillPreview,
  runDistillApply,
} from './distill/core';

export interface DistillCliArguments {
  vaultDir: string;
  mode: 'preview' | 'apply';
  practicePath?: string;
  previewDigest?: string;
  gates?: string[];
}

const USAGE =
  'Usage: distill --vault-dir DIR preview --practice PATH [--gates gate1,gate2]\n' +
  '       distill --vault-dir DIR apply --practice PATH --preview-digest DIGEST';

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseDistillArguments(argv: string[]): DistillCliArguments {
  const args = [...argv];
  let vaultDir: string | undefined;
  let mode: 'preview' | 'apply' | undefined;
  let practicePath: string | undefined;
  let previewDigest: string | undefined;
  let gates: string[] | undefined;

  let i = 0;
  while (i < args.length) {
    const flag = args[i];
    switch (flag) {
      case '--vault-dir':
        if (vaultDir !== undefined) throw new Error('Duplicate --vault-dir');
        vaultDir = requireValue(args, ++i, flag);
        i++;
        break;
      case 'preview':
        if (mode !== undefined) throw new Error(`Duplicate mode: ${flag}`);
        mode = 'preview';
        i++;
        break;
      case 'apply':
        if (mode !== undefined) throw new Error(`Duplicate mode: ${flag}`);
        mode = 'apply';
        i++;
        break;
      case '--practice':
        if (practicePath !== undefined) throw new Error('Duplicate --practice');
        practicePath = requireValue(args, ++i, flag);
        i++;
        break;
      case '--preview-digest':
        if (previewDigest !== undefined) throw new Error('Duplicate --preview-digest');
        previewDigest = requireValue(args, ++i, flag);
        i++;
        break;
      case '--gates': {
        const value = requireValue(args, ++i, flag);
        gates = value.split(',').map(s => s.trim()).filter(Boolean);
        i++;
        break;
      }
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown option: ${flag}`);
        throw new Error(`Unexpected argument: ${flag}`);
    }
  }

  if (!vaultDir) throw new Error('Missing required --vault-dir');
  if (!mode) throw new Error('Missing required mode: preview or apply');

  if (mode === 'preview' && !practicePath) {
    throw new Error('Preview mode requires --practice PATH');
  }
  if (mode === 'apply') {
    if (!practicePath) throw new Error('Apply mode requires --practice PATH');
    if (!previewDigest) throw new Error('Apply mode requires --preview-digest DIGEST');
  }

  return {
    vaultDir,
    mode,
    ...(practicePath ? { practicePath } : {}),
    ...(previewDigest ? { previewDigest } : {}),
    ...(gates ? { gates } : {}),
  };
}

function errorResult(code: string, message: string): DistillResultV1 {
  return {
    version: 1,
    status: 'validation_failed',
    operationId: '',
    previewDigest: '',
    changedPaths: [],
    plannedPaths: [],
    indexAction: 'none',
    warnings: [],
    error: { code, message },
    recoveryState: 'none',
    recoveries: [],
  };
}

export function runDistillCli(argv: string[]): number {
  let cli: DistillCliArguments;
  try {
    cli = parseDistillArguments(argv);
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

  if (cli.mode === 'preview') {
    try {
      const result = runDistillPreview({
        vaultDir: cli.vaultDir,
        practicePath: cli.practicePath!,
        gateNames: cli.gates,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } catch (err) {
      if (err instanceof DistillError) {
        process.stdout.write(`${JSON.stringify(errorResult(err.code, err.message))}\n`);
        return DISTILL_ERROR_CODES[err.code]?.exitCode ?? 1;
      }
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`${JSON.stringify(errorResult('INTERNAL_ERROR', message))}\n`);
      return 1;
    }
  }

  // Apply mode
  try {
    const result = runDistillApply({
      vaultDir: cli.vaultDir,
      practicePath: cli.practicePath!,
      previewDigest: cli.previewDigest!,
      gateNames: cli.gates,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'committed' ? 0 : 4;
  } catch (err) {
    if (err instanceof DistillError) {
      process.stdout.write(`${JSON.stringify(errorResult(err.code, err.message))}\n`);
      return DISTILL_ERROR_CODES[err.code]?.exitCode ?? 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${JSON.stringify(errorResult('INTERNAL_ERROR', message))}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runDistillCli(process.argv.slice(2));
}
