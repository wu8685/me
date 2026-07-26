export type LogicalLayer = 'raw' | 'practices' | 'cognition';

export type VaultWriteStatus =
  | 'preview'
  | 'committed'
  | 'validation_failed'
  | 'conflict'
  | 'unsupported'
  | 'manual_recovery';

export interface VaultWriteRequestV1 {
  version: 1;
  layer: LogicalLayer;
  relativePath: string;
  markdown: string;
  index: { mode: 'auto' };
  acknowledgeCognition?: boolean;
}

export interface VaultWriteRecovery {
  operationId: string;
  state:
    | 'retained-original'
    | 'incomplete-operation'
    | 'unrecognized-operation'
    | 'ownership-conflict';
  directory: string;
  journal?: string;
  preservedPaths: string[];
  remainingMutations: string[];
  actions: Array<{
    kind: 'inspect' | 'compare' | 'restore' | 'remove-owned';
    path: string;
    from?: string;
    condition: string;
  }>;
}

export interface VaultWriteResultV1 {
  version: 1;
  status: VaultWriteStatus;
  operationId: string;
  commitModel: 'preview-only' | 'journaled-cooperative';
  requestDigest: string;
  notePath?: string;
  changedPaths: string[];
  plannedPaths: string[];
  indexAction: 'none' | 'create' | 'replace';
  backlinks: Array<{ path: string; count: number }>;
  unlinkedMentions: Array<{ path: string; count: number; offsets: number[] }>;
  warnings: string[];
  error?: { code: string; message: string };
  recoveryState: 'none' | 'retained-originals' | 'incomplete';
  recoveries: VaultWriteRecovery[];
}

export type WriterErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_CONFIG'
  | 'UNSAFE_PATH'
  | 'UNSUPPORTED_SCHEMA'
  | 'INVALID_NOTE'
  | 'DUPLICATE_STEM'
  | 'TARGET_EXISTS'
  | 'LOCK_HELD'
  | 'INPUT_CHANGED'
  | 'UNSUPPORTED_FILESYSTEM'
  | 'POST_VALIDATION_FAILED'
  | 'INCOMPLETE_OPERATION'
  | 'RECOVERY_REQUIRED'
  | 'LEGACY_RUNTIME_STATE'
  | 'INTERNAL_ERROR';

export interface WriterErrorDefinition {
  status: VaultWriteStatus;
  exitCode: 1 | 2 | 3 | 4 | 5;
  message: string;
}

function definition(
  status: VaultWriteStatus,
  exitCode: 1 | 2 | 3 | 4 | 5,
  message: string,
): Readonly<WriterErrorDefinition> {
  return Object.freeze({ status, exitCode, message });
}

export const WRITER_ERROR_CATALOG: Readonly<Record<WriterErrorCode, WriterErrorDefinition>> =
  Object.freeze({
    INVALID_REQUEST: definition('validation_failed', 2, 'Request does not match vault-write v1.'),
    INVALID_CONFIG: definition('validation_failed', 2, 'Vault layer configuration is invalid.'),
    UNSAFE_PATH: definition('validation_failed', 2, 'A required path is outside the safe vault layout.'),
    UNSUPPORTED_SCHEMA: definition('validation_failed', 2, 'Vault schema revision is not supported by this ME version.'),
    INVALID_NOTE: definition('validation_failed', 2, 'Note does not match the selected schema profile.'),
    DUPLICATE_STEM: definition('conflict', 3, 'A note with this stem already exists.'),
    TARGET_EXISTS: definition('conflict', 3, 'The requested target already exists.'),
    LOCK_HELD: definition('conflict', 3, 'Another vault-write operation may still be active.'),
    INPUT_CHANGED: definition('conflict', 3, 'Vault inputs changed after planning; nothing new was published.'),
    UNSUPPORTED_FILESYSTEM: definition('unsupported', 5, 'Filesystem cannot provide the required no-clobber primitive.'),
    POST_VALIDATION_FAILED: definition('validation_failed', 2, 'Post-write validation failed and owned changes were restored.'),
    INCOMPLETE_OPERATION: definition('manual_recovery', 4, 'One or more incomplete operations require inspection.'),
    RECOVERY_REQUIRED: definition('manual_recovery', 4, 'Conflicting content was preserved; manual recovery is required.'),
    LEGACY_RUNTIME_STATE: definition('manual_recovery', 4, 'Vault-local ME 1.5 runtime state requires inspection.'),
    INTERNAL_ERROR: definition('validation_failed', 1, 'Vault write could not complete safely.'),
  });

export class VaultWriterError extends Error {
  readonly code: WriterErrorCode;

  constructor(code: WriterErrorCode) {
    super(WRITER_ERROR_CATALOG[code].message);
    this.name = 'VaultWriterError';
    this.code = code;
  }
}

const REQUEST_KEYS = new Set([
  'version',
  'layer',
  'relativePath',
  'markdown',
  'index',
  'acknowledgeCognition',
]);
const LAYERS = new Set<LogicalLayer>(['raw', 'practices', 'cognition']);
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
const NOTE_BASENAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(): never {
  throw new VaultWriterError('INVALID_REQUEST');
}

function validateRelativePath(value: string): void {
  if (
    !value
    || value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || WINDOWS_DRIVE.test(value)
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalidRequest();
  }

  const components = value.split('/');
  if (
    components.some(component => component === '' || component === '.' || component === '..')
    || !NOTE_BASENAME.test(components.at(-1) ?? '')
  ) {
    invalidRequest();
  }
}

export function parseVaultWriteRequest(value: unknown): VaultWriteRequestV1 {
  if (!isRecord(value) || Object.keys(value).some(key => !REQUEST_KEYS.has(key))) {
    invalidRequest();
  }
  if (value.version !== 1 || typeof value.layer !== 'string' || !LAYERS.has(value.layer as LogicalLayer)) {
    invalidRequest();
  }
  if (typeof value.relativePath !== 'string') invalidRequest();
  validateRelativePath(value.relativePath);

  if (
    typeof value.markdown !== 'string'
    || value.markdown.trim().length === 0
    || Buffer.byteLength(value.markdown, 'utf8') > MAX_MARKDOWN_BYTES
  ) {
    invalidRequest();
  }

  if (
    !isRecord(value.index)
    || Object.keys(value.index).length !== 1
    || value.index.mode !== 'auto'
  ) {
    invalidRequest();
  }
  if (
    value.acknowledgeCognition !== undefined
    && typeof value.acknowledgeCognition !== 'boolean'
  ) {
    invalidRequest();
  }
  if (value.layer === 'cognition' && value.acknowledgeCognition !== true) {
    invalidRequest();
  }
  const acknowledgeCognition = value.acknowledgeCognition as boolean | undefined;

  return {
    version: 1,
    layer: value.layer as LogicalLayer,
    relativePath: value.relativePath,
    markdown: value.markdown,
    index: { mode: 'auto' },
    ...(acknowledgeCognition === undefined
      ? {}
      : { acknowledgeCognition }),
  };
}
