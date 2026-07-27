export {
  fingerprintMutationSource,
  validatePlannedMutations,
} from '../mutation/contracts';
export type {
  PlannedMutation,
  SourceFingerprint,
} from '../mutation/contracts';

import type { PlannedMutation } from '../mutation/contracts';

export const CURRENT_VAULT_SCHEMA_VERSION = 1;

export type UpdateStatus =
  | 'up_to_date'
  | 'preview'
  | 'blocked'
  | 'committed'
  | 'rolled_back'
  | 'recovery_required';

export type UpdateErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_A_ME_VAULT'
  | 'INVALID_CONFIG'
  | 'INVALID_VAULT_SCHEMA_VERSION'
  | 'VAULT_NEWER_THAN_PLUGIN'
  | 'INVALID_MIGRATION_REGISTRY'
  | 'MIGRATION_CONFLICT'
  | 'STALE_PREVIEW'
  | 'UPDATE_IN_PROGRESS'
  | 'UNSAFE_PATH'
  | 'UNSUPPORTED_FILESYSTEM'
  | 'LEGACY_RUNTIME_STATE'
  | 'VALIDATION_FAILED'
  | 'RECOVERY_REQUIRED'
  | 'INTERNAL_ERROR';

export interface UpdatePlan {
  status: 'up_to_date' | 'preview' | 'blocked';
  currentVaultSchemaVersion: number;
  targetVaultSchemaVersion: number;
  migrations: Array<{ id: string; description: string }>;
  mutations: PlannedMutation[];
  plannedPaths: string[];
  diffs: Array<{ path: string; diff: string }>;
  warnings: string[];
  conflicts: Array<{ path: string; reason: string }>;
  planDigest: string;
}

export interface UpdateResultV1 {
  version: 1;
  status: UpdateStatus;
  operationId: string;
  currentVaultSchemaVersion: number;
  targetVaultSchemaVersion: number;
  migrations: Array<{ id: string; description: string }>;
  planDigest?: string;
  plannedPaths: string[];
  changedPaths: string[];
  diffs: Array<{ path: string; diff: string }>;
  warnings: string[];
  conflicts: Array<{ path: string; reason: string }>;
  recoveryState: 'none' | 'rolled_back' | 'manual';
  error?: { code: UpdateErrorCode; message: string };
}

export interface UpdateErrorDefinition {
  status: Extract<UpdateStatus, 'blocked' | 'rolled_back' | 'recovery_required'>;
  exitCode: 1 | 2 | 3 | 4 | 5;
  message: string;
}

function definition(
  status: UpdateErrorDefinition['status'],
  exitCode: UpdateErrorDefinition['exitCode'],
  message: string,
): Readonly<UpdateErrorDefinition> {
  return Object.freeze({ status, exitCode, message });
}

export const UPDATE_ERROR_CATALOG: Readonly<
  Record<UpdateErrorCode, Readonly<UpdateErrorDefinition>>
> = Object.freeze({
  INVALID_REQUEST: definition(
    'blocked',
    2,
    'INVALID_REQUEST: Request does not match me-update v1.',
  ),
  NOT_A_ME_VAULT: definition(
    'blocked',
    2,
    'NOT_A_ME_VAULT: The selected directory is not an initialized ME vault.',
  ),
  INVALID_CONFIG: definition(
    'blocked',
    2,
    'INVALID_CONFIG: Vault configuration is invalid.',
  ),
  INVALID_VAULT_SCHEMA_VERSION: definition(
    'blocked',
    2,
    'INVALID_VAULT_SCHEMA_VERSION: Vault schema version must be a non-negative safe integer.',
  ),
  VAULT_NEWER_THAN_PLUGIN: definition(
    'blocked',
    5,
    'VAULT_NEWER_THAN_PLUGIN: Vault schema is newer than this ME version.',
  ),
  INVALID_MIGRATION_REGISTRY: definition(
    'blocked',
    2,
    'INVALID_MIGRATION_REGISTRY: Installed ME migration registry is invalid.',
  ),
  MIGRATION_CONFLICT: definition(
    'blocked',
    3,
    'MIGRATION_CONFLICT: Vault content conflicts with the required migration.',
  ),
  STALE_PREVIEW: definition(
    'blocked',
    3,
    'STALE_PREVIEW: Vault inputs changed after preview; no update was applied.',
  ),
  UPDATE_IN_PROGRESS: definition(
    'blocked',
    3,
    'UPDATE_IN_PROGRESS: Another ME vault update may still be active.',
  ),
  UNSAFE_PATH: definition(
    'blocked',
    2,
    'UNSAFE_PATH: A required path is outside the safe vault layout.',
  ),
  UNSUPPORTED_FILESYSTEM: definition(
    'blocked',
    5,
    'UNSUPPORTED_FILESYSTEM: Filesystem cannot provide the required no-clobber primitive.',
  ),
  LEGACY_RUNTIME_STATE: definition(
    'recovery_required',
    4,
    'LEGACY_RUNTIME_STATE: Vault-local ME 1.5 runtime state requires inspection.',
  ),
  VALIDATION_FAILED: definition(
    'rolled_back',
    2,
    'VALIDATION_FAILED: Post-migration validation failed and owned changes were restored.',
  ),
  RECOVERY_REQUIRED: definition(
    'recovery_required',
    4,
    'RECOVERY_REQUIRED: Conflicting content was preserved; manual recovery is required.',
  ),
  INTERNAL_ERROR: definition(
    'blocked',
    1,
    'INTERNAL_ERROR: Vault update could not complete safely.',
  ),
});

export class UpdateError extends Error {
  readonly code: UpdateErrorCode;

  constructor(code: UpdateErrorCode) {
    super(UPDATE_ERROR_CATALOG[code].message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

const PATH_TOKEN_END = String.raw`\s,;)}\]"'<>\uE000\uE001`;
const FILE_URI_TOKEN_END = `${PATH_TOKEN_END}&?#`;
const ABSOLUTE_PATH_PATTERNS = [
  new RegExp(
    String.raw`(?<![A-Za-z0-9+.-])file:[\\/]{1,3}[^${PATH_TOKEN_END}]+`,
    'gi',
  ),
  new RegExp(
    String.raw`(?<![A-Za-z0-9_/\\])\\\\[^${PATH_TOKEN_END}]+`,
    'g',
  ),
  new RegExp(
    String.raw`(?<![A-Za-z0-9_/\\])[A-Za-z]:[\\/][^${PATH_TOKEN_END}]+`,
    'g',
  ),
  new RegExp(
    String.raw`(?<![A-Za-z0-9_/\\])\/+[^${PATH_TOKEN_END}]*`,
    'g',
  ),
] as const;

function isAbsolutePathToken(value: string): boolean {
  return /^file:[\\/]{1,3}/i.test(value)
    || /^\/+/.test(value)
    || /^[A-Za-z]:[\\/]/.test(value)
    || /^\\\\/.test(value);
}

function redactDelimitedPaths(value: string): string {
  return value
    .replace(/<([^<>\r\n]*)>/g, (match, contents: string) => (
      isAbsolutePathToken(contents) ? '<ABSOLUTE_PATH>' : match
    ))
    .replace(/"([^"\r\n]*)"|'([^'\r\n]*)'/g, (
      match,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
    ) => {
      const contents = doubleQuoted ?? singleQuoted;
      if (!isAbsolutePathToken(contents)) return match;
      return doubleQuoted === undefined
        ? "'<ABSOLUTE_PATH>'"
        : '"<ABSOLUTE_PATH>"';
    });
}

function redactAbsolutePaths(value: string): string {
  const protectedTokens: string[] = [];
  let sentinelPrefix = '\u{e000}PROTECTED_';
  while (value.includes(sentinelPrefix)) sentinelPrefix += '_';
  const protect = (source: string, pattern: RegExp): string => (
    source.replace(pattern, match => {
      const sentinel = `${sentinelPrefix}${protectedTokens.length}\u{e001}`;
      protectedTokens.push(match);
      return sentinel;
    })
  );
  // File URLs are local paths, even when nested inside an otherwise safe URI.
  // Redact them before protecting ordinary URI tokens.
  let protectedValue = value.replace(
    new RegExp(
      String.raw`(?<![A-Za-z0-9+.-])file:[\\/]{1,3}[^${FILE_URI_TOKEN_END}]+`,
      'gi',
    ),
    '<ABSOLUTE_PATH>',
  );
  protectedValue = protect(
    protectedValue,
    /<ME_RUNTIME>(?:[\\/][^\s,;)}\]"'<>]+)?/g,
  );
  protectedValue = protect(
    protectedValue,
    /(?<![A-Za-z0-9_])\/me:[a-z][a-z0-9-]*/g,
  );
  protectedValue = protect(
    protectedValue,
    /\b(?!file:)(?![A-Za-z]:[\\/])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s,;)}\]"'<>]+/gi,
  );
  protectedValue = protect(
    protectedValue,
    /<\/[A-Za-z][A-Za-z0-9:-]*\s*>/g,
  );
  protectedValue = redactDelimitedPaths(protectedValue);
  const redacted = ABSOLUTE_PATH_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, '<ABSOLUTE_PATH>'),
    protectedValue,
  );
  return protectedTokens.reduce(
    (restored, token, index) => restored.replace(
      `${sentinelPrefix}${index}\u{e001}`,
      token,
    ),
    redacted,
  );
}

function redactPublicValue(value: unknown): unknown {
  if (
    Buffer.isBuffer(value)
    || value instanceof Uint8Array
    || value instanceof ArrayBuffer
  ) {
    return '<BINARY_DATA>';
  }
  if (typeof value === 'string') {
    return redactAbsolutePaths(value);
  }
  if (Array.isArray(value)) return value.map(redactPublicValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactPublicValue(item)]),
    );
  }
  return value;
}

export function sanitizePublicUpdateResult(
  result: UpdateResultV1,
): UpdateResultV1 {
  return redactPublicValue(result) as UpdateResultV1;
}

export function serializeUpdateResult(result: UpdateResultV1): string {
  return `${JSON.stringify(sanitizePublicUpdateResult(result))}\n`;
}
