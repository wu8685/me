import type {
  CapabilityReport,
  ExtractContext,
  ExtractedSource,
  SourceAdapter,
} from './contracts.ts';

export class AdapterExtractionError extends Error {
  readonly adapterId: string;
  readonly cause: unknown;

  constructor(adapterId: string, operation: 'probe' | 'extract', cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Adapter ${adapterId} ${operation} failed: ${reason}`);
    this.name = 'AdapterExtractionError';
    this.adapterId = adapterId;
    this.cause = cause;
  }
}

export function createAdapterRegistry(adapters: SourceAdapter[]) {
  function match(url: URL): SourceAdapter {
    const adapter = adapters.find((candidate) => candidate.matches(url));
    if (!adapter) {
      throw new Error(`No source adapter matches URL: ${url.toString()}`);
    }
    return adapter;
  }

  async function probe(url: URL, context: ExtractContext): Promise<CapabilityReport> {
    const adapter = match(url);
    try {
      return await adapter.probe({ ...context, url });
    } catch (cause) {
      throw new AdapterExtractionError(adapter.id, 'probe', cause);
    }
  }

  async function extract(url: URL, context: ExtractContext): Promise<ExtractedSource> {
    const adapter = match(url);
    try {
      return await adapter.extract({ ...context, url });
    } catch (cause) {
      throw new AdapterExtractionError(adapter.id, 'extract', cause);
    }
  }

  return { match, probe, extract };
}
