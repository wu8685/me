#!/usr/bin/env -S bun run

/**
 * route-check — the pre-write layer decision contract.
 *
 * Run before proposing any note write. It classifies the candidate markdown,
 * applies the routing precedence
 *
 *   semantic knowledge type > layer schema constraints > existing directory convention
 *
 * and reports:
 *
 * - deterministic schema violations for the declared layer (blocking);
 * - heuristic semantic-routing advisories (visible, require confirmation,
 *   never silently overridden by legacy neighbors).
 *
 * Strictly read-only: the vault is never modified. Cognition writes remain
 * gated by me:distill — pass --via-distill only from that flow.
 *
 * Usage:
 *   route-check --vault-dir DIR --layer LAYER (--file PATH | --stdin)
 *               [--knowledge-type external-source|practice-record|distilled-insight]
 *               [--via-distill]
 *
 * Exit codes: 0 = ok/advisory, 2 = invalid arguments, 3 = blocked.
 */

import * as fs from 'fs';
import type { LogicalLayer } from './vault-write/contracts';
import {
  analyzeNoteRouting,
  classifyKnowledgeType,
  decideLayer,
  parseLooseNote,
  type KnowledgeType,
  type RoutingFinding,
  type RoutingGateCode,
} from './vault-write/routing';

const LAYERS = new Set<LogicalLayer>(['raw', 'practices', 'cognition']);
const KNOWLEDGE_TYPES = new Set<KnowledgeType>(['external-source', 'practice-record', 'distilled-insight']);

const USAGE = 'Usage: route-check --vault-dir DIR --layer LAYER (--file PATH | --stdin) [--knowledge-type TYPE] [--via-distill]';

interface RouteCheckArguments {
  vaultDir: string;
  layer: LogicalLayer;
  file?: string;
  stdin?: boolean;
  knowledgeType?: KnowledgeType;
  viaDistill: boolean;
}

interface RouteCheckReport {
  version: 1;
  status: 'ok' | 'advisory' | 'blocked';
  decision: {
    declaredLayer: LogicalLayer;
    knowledgeType: KnowledgeType;
    knowledgeTypeSource: 'declared' | 'heuristic';
    expectedLayer: LogicalLayer;
    layerMatches: boolean;
    precedence: readonly string[];
    explanation: string;
    mixedSourceAndJudgment: boolean;
  };
  requiresConfirmation: boolean;
  errors: RoutingFinding[];
  advisories: RoutingFinding[];
  error?: { code: string; message: string };
}

function invalid(message: string): never {
  process.stdout.write(`${JSON.stringify({ status: 'error', error: { code: 'INVALID_ARGUMENTS', message } })}\n`);
  process.exit(2);
}

function parseArguments(argv: string[]): RouteCheckArguments {
  let vaultDir: string | undefined;
  let layer: string | undefined;
  let file: string | undefined;
  let stdin = false;
  let knowledgeType: string | undefined;
  let viaDistill = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--stdin') {
      stdin = true;
      continue;
    }
    if (flag === '--via-distill') {
      viaDistill = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) invalid(USAGE);
    if (flag === '--vault-dir' && vaultDir === undefined) vaultDir = value;
    else if (flag === '--layer' && layer === undefined) layer = value;
    else if (flag === '--file' && file === undefined) file = value;
    else if (flag === '--knowledge-type' && knowledgeType === undefined) knowledgeType = value;
    else invalid(USAGE);
    index += 1;
  }

  if (!vaultDir) invalid(USAGE);
  if (!layer || !LAYERS.has(layer as LogicalLayer)) invalid(`Unknown layer. ${USAGE}`);
  if ((file === undefined) === !stdin) invalid(`Provide exactly one of --file or --stdin. ${USAGE}`);
  if (knowledgeType !== undefined && !KNOWLEDGE_TYPES.has(knowledgeType as KnowledgeType)) {
    invalid(`Unknown knowledge type. ${USAGE}`);
  }
  return {
    vaultDir,
    layer: layer as LogicalLayer,
    ...(file !== undefined ? { file } : {}),
    ...(stdin ? { stdin: true } : {}),
    ...(knowledgeType !== undefined ? { knowledgeType: knowledgeType as KnowledgeType } : {}),
    viaDistill,
  };
}

function readMarkdown(args: RouteCheckArguments): string {
  if (args.stdin) {
    return fs.readFileSync(0, 'utf8');
  }
  try {
    return fs.readFileSync(args.file as string, 'utf8');
  } catch {
    invalid(`Cannot read --file. ${USAGE}`);
  }
}

function gateAdvisory(code: RoutingGateCode, message: string, recommendedAction: string): RoutingFinding {
  return {
    code,
    severity: 'advisory',
    heuristic: true,
    message,
    recommendedAction,
    evidence: [],
  };
}

export function runRouteCheck(argv: string[]): { report: RouteCheckReport; exitCode: number } {
  const args = parseArguments(argv);
  const markdown = readMarkdown(args);

  const note = parseLooseNote(markdown);
  const classification = classifyKnowledgeType(note?.fields ?? new Map(), note?.body ?? '');
  const knowledgeType = args.knowledgeType ?? classification.knowledgeType;
  const decision = decideLayer(knowledgeType);
  const layerMatches = decision.layer === args.layer;

  // Deterministic schema validation always runs against the declared layer:
  // it answers "is this intended write valid". A semantic layer mismatch is
  // advisory and asks for confirmation instead of pretending to be certain.
  const analysis = analyzeNoteRouting(args.layer, markdown);
  const errors = [...analysis.errors];
  const advisories: RoutingFinding[] = [...analysis.advisories];

  let requiresConfirmation = false;
  if (!layerMatches) {
    requiresConfirmation = true;
    advisories.unshift({
      code: 'ROUTING_LAYER_NEEDS_CONFIRMATION',
      severity: 'advisory',
      heuristic: true,
      message: `Content classifies as "${knowledgeType}", which belongs in the ${decision.layer} layer, not ${args.layer}. Existing notes in ${args.layer} are navigation evidence, not routing evidence.`,
      recommendedAction: `Write to the ${decision.layer} layer instead, or confirm explicitly that the ${args.layer} layer is intended.`,
      evidence: args.knowledgeType ? ['declared-knowledge-type'] : classification.signals,
    });
  }

  if (classification.mixedSourceAndJudgment) {
    advisories.push(gateAdvisory(
      'ROUTING_MIXED_SOURCE_AND_JUDGMENT',
      'Content mixes external source material with local judgment.',
      'Preserve the source capture in the raw layer and write the interpretation or decision separately in practices with a [[wikilink]] provenance back to the raw note.',
    ));
  }

  if (args.layer === 'cognition' && !args.viaDistill) {
    requiresConfirmation = true;
    advisories.push(gateAdvisory(
      'ROUTING_COGNITION_REQUIRES_DISTILL',
      'Cognition writes must go through the evidence-gated me:distill promotion flow.',
      'Run me:distill instead of writing a cognition note directly; do not bypass the evidence gates.',
    ));
  }

  const blocked = errors.length > 0;
  const report: RouteCheckReport = {
    version: 1,
    status: blocked ? 'blocked' : advisories.length > 0 ? 'advisory' : 'ok',
    decision: {
      declaredLayer: args.layer,
      knowledgeType,
      knowledgeTypeSource: args.knowledgeType ? 'declared' : 'heuristic',
      expectedLayer: decision.layer,
      layerMatches,
      precedence: decision.precedence,
      explanation: decision.explanation,
      mixedSourceAndJudgment: classification.mixedSourceAndJudgment,
    },
    requiresConfirmation,
    errors,
    advisories,
  };
  return { report, exitCode: blocked ? 3 : 0 };
}

if (require.main === module) {
  const { report, exitCode } = runRouteCheck(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = exitCode;
}
