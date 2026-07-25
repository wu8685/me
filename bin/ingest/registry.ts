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

export interface AdapterRegistryOptions {
  resolveContentType?: (url: URL) => Promise<string | undefined>;
}

export function createAdapterRegistry(adapters: SourceAdapter[], options: AdapterRegistryOptions = {}) {
  function match(url: URL): SourceAdapter {
    const adapter = adapters.find((candidate) => candidate.matches(url));
    if (!adapter) {
      throw new Error(`No source adapter matches URL: ${url.toString()}`);
    }
    return adapter;
  }

  async function resolve(url: URL): Promise<SourceAdapter> {
    const adapter = match(url);
    if (!adapter.fallback || !options.resolveContentType) return adapter;
    try {
      const contentType = await options.resolveContentType(url);
      if (!contentType) return adapter;
      return adapters.find((candidate) => candidate.matchesContentType?.(contentType)) ?? adapter;
    } catch {
      return adapter;
    }
  }

  function sessionFor(url: URL, adapter: SourceAdapter) {
    return {
      adapter,
      async probe(context: ExtractContext): Promise<CapabilityReport> {
        try {
          return await adapter.probe({ ...context, url });
        } catch (cause) {
          throw new AdapterExtractionError(adapter.id, 'probe', cause);
        }
      },
      async extract(context: ExtractContext): Promise<ExtractedSource> {
        try {
          return await adapter.extract({ ...context, url });
        } catch (cause) {
          throw new AdapterExtractionError(adapter.id, 'extract', cause);
        }
      },
    };
  }

  async function resolveSession(url: URL) {
    return sessionFor(url, await resolve(url));
  }

  async function probe(url: URL, context: ExtractContext): Promise<CapabilityReport> {
    return (await resolveSession(url)).probe(context);
  }

  async function extract(url: URL, context: ExtractContext): Promise<ExtractedSource> {
    return (await resolveSession(url)).extract(context);
  }

  return { match, resolve, resolveSession, probe, extract };
}
