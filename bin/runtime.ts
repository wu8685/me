#!/usr/bin/env -S bun run

import * as fs from 'fs';
import {
  RuntimePathError,
  bootstrapRuntimeDirectories,
  resolveRuntimeLayout,
} from './runtime-paths';

type RuntimeCommand = 'path' | 'prepare-inbox';

interface RuntimeArguments {
  command: RuntimeCommand;
  vaultDir: string;
}

const USAGE = 'Usage: runtime path|prepare-inbox --vault-dir DIR';

function parseArguments(argv: string[]): RuntimeArguments {
  if (
    argv.length !== 3
    || (argv[0] !== 'path' && argv[0] !== 'prepare-inbox')
    || argv[1] !== '--vault-dir'
    || !argv[2]
    || argv[2].startsWith('--')
  ) {
    throw new Error('INVALID_ARGUMENTS');
  }
  return { command: argv[0], vaultDir: argv[2] };
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function runRuntime(argv: string[]): number {
  let args: RuntimeArguments;
  try {
    args = parseArguments(argv);
  } catch {
    writeJson({
      status: 'error',
      error: { code: 'INVALID_ARGUMENTS', message: USAGE },
    });
    return 2;
  }

  try {
    const layout = resolveRuntimeLayout(args.vaultDir, process.env);
    if (args.command === 'path') {
      writeJson({
        vaultDir: layout.canonicalVault,
        runtimeRoot: layout.runtimeRoot,
        exists: fs.existsSync(layout.runtimeRoot),
      });
      return 0;
    }

    bootstrapRuntimeDirectories(layout, [layout.inboxDir]);
    writeJson({
      vaultDir: layout.canonicalVault,
      runtimeRoot: layout.runtimeRoot,
      inboxDir: layout.inboxDir,
      exists: true,
    });
    return 0;
  } catch (error) {
    const code = error instanceof RuntimePathError ? error.code : 'INTERNAL_ERROR';
    writeJson({
      status: 'error',
      error: { code, message: 'ME runtime path could not be prepared safely.' },
    });
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runRuntime(process.argv.slice(2));
}
