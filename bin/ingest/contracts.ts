export type SourceKind = 'article' | 'paper' | 'video' | 'course';
export type ExtractMode = 'raw' | 'translate-cn' | 'summarize' | 'transcribe' | 'handout';
export type Capability = 'body' | 'images' | 'captions' | 'transcript' | 'audio' | 'video' | 'slides';

export interface SourceBlock {
  id: string;
  kind: 'heading' | 'paragraph' | 'quote' | 'code' | 'image' | 'figure';
  markdown: string;
  mediaId?: string;
  page?: number;
}

export interface TranscriptSegment { start: number; end: number; text: string; speaker?: string }
export interface MediaAsset {
  id: string;
  kind: 'image' | 'figure' | 'audio' | 'video' | 'slide' | 'frame';
  path?: string;
  url?: string;
  alt?: string;
  caption?: string;
  timestampSec?: number;
  page?: number;
}

export interface ExtractedSource {
  source: {
    url: string;
    canonicalUrl?: string;
    kind: SourceKind;
    title: string;
    author?: string;
    publishedAt?: string;
    language?: string;
    durationSec?: number;
  };
  blocks: SourceBlock[];
  transcript?: TranscriptSegment[];
  media: MediaAsset[];
  provenance: { extractor: string; extractedAt: string; methods: string[] };
  warnings: string[];
}

export interface CapabilityReport {
  adapterId: string;
  readable: boolean;
  capabilities: Capability[];
  missingDependencies?: string[];
  degradation?: 'none' | 'partial' | 'blocked';
  warnings: string[];
}

export interface ExtractContext { vaultDir: string; mode?: ExtractMode; tempDir?: string }
export interface SourceAdapter {
  id: string;
  matches(url: URL): boolean;
  probe(context: ExtractContext & { url: URL }): Promise<CapabilityReport>;
  extract(context: ExtractContext & { url: URL }): Promise<ExtractedSource>;
}
