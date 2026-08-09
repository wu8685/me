#!/usr/bin/env -S bun run

/**
 * me:brief — deterministic claim ledger validation for evidence-calibrated
 * briefs (contract v1).
 *
 * Reads a claim ledger (contract `claim-ledger`) from stdin or --ledger and
 * emits a versioned JSON report (contract `brief-ledger`). Strictly read-only:
 * never writes the vault, runtime, indexes, or any file; never uses the
 * network. Exit 0 means a report was produced — including reports with
 * findings or insufficient evidence. Exit 2 means invalid arguments or input.
 */

import * as fs from 'fs';
import { LedgerInputError, validateLedger } from './brief/ledger';

const USAGE = 'Usage: brief validate [--ledger FILE] [--now ISO_DATE]';

function fail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

function main(argv: string[]): void {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (argv.length === 0 || argv[0] !== 'validate') fail('missing or unknown subcommand');

  let ledgerPath: string | null = null;
  let nowValue: string | null = null;
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--ledger' && value !== undefined && !value.startsWith('--')) {
      ledgerPath = value;
      i += 1;
    } else if (flag === '--now' && value !== undefined && !value.startsWith('--')) {
      nowValue = value;
      i += 1;
    } else {
      fail(`unknown or incomplete flag: ${flag}`);
    }
  }

  const now = nowValue === null ? new Date() : new Date(nowValue);
  if (Number.isNaN(now.getTime())) fail(`invalid --now date: ${nowValue}`);

  let raw: string;
  try {
    raw = ledgerPath === null ? fs.readFileSync(0, 'utf8') : fs.readFileSync(ledgerPath, 'utf8');
  } catch {
    fail(`cannot read ledger: ${ledgerPath ?? 'stdin'}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('ledger is not valid JSON');
  }

  try {
    const report = validateLedger(parsed, now);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    if (error instanceof LedgerInputError) fail(`malformed ledger: ${error.message}`);
    throw error;
  }
}

main(process.argv.slice(2));
