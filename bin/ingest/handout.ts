import type { ExtractedSource, MediaAsset, TranscriptSegment } from './contracts.ts';
import {
  handoutMediaEmbed,
  selectTimestampedFrames,
  selectTimestampedSlides,
} from './media/frames.ts';

export interface TopicHeading {
  start: number;
  end: number;
  title: string;
}

export interface HandoutOptions {
  topicHeadings: TopicHeading[];
  editorialNote?: string;
}

export interface HandoutResult {
  kind: 'slide' | 'topic';
  markdown: string;
  usedMediaIds: string[];
  omittedTranscriptSegments: number[];
  warnings: string[];
}

interface Section {
  start: number;
  end: number;
  title: string;
  media: MediaAsset[];
  transcript: Array<{ index: number; segment: TranscriptSegment }>;
}

const MIN_TOPIC_SECONDS = 5 * 60;
const TARGET_TOPIC_SECONDS = 8 * 60;
const MAX_TOPIC_SECONDS = 12 * 60;
const EPSILON = 0.001;

function formatTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = value % 60;
  const pad = (part: number) => String(part).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${pad(minutes)}:${pad(remainder)}`;
}

function validDuration(source: ExtractedSource): number {
  const declared = source.source.durationSec;
  if (declared !== undefined && Number.isFinite(declared) && declared >= 0) return declared;
  return Math.max(
    0,
    ...((source.transcript ?? []).map(segment => Number.isFinite(segment.end) ? segment.end : 0)),
    ...(source.media.map(asset => asset.timestampSec !== undefined && Number.isFinite(asset.timestampSec)
      ? asset.timestampSec
      : 0)),
  );
}

function sameTime(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function validateTopicHeadings(headings: TopicHeading[], duration: number): TopicHeading[] {
  if (headings.length === 0) return [];
  for (const [index, heading] of headings.entries()) {
    if (!Number.isFinite(heading.start) || !Number.isFinite(heading.end) || heading.start < 0) {
      throw new Error(`topic heading ${index + 1} range must be finite and non-negative`);
    }
    if (heading.start >= heading.end) {
      throw new Error(`topic heading ${index + 1} range must satisfy start < end`);
    }
    if (heading.end > duration + EPSILON) {
      throw new Error(`topic heading ${index + 1} range exceeds source duration`);
    }
    if (!heading.title.trim()) throw new Error(`topic heading ${index + 1} title is empty`);
    if (index === 0 && !sameTime(heading.start, 0)) {
      throw new Error('topic heading ranges must start at zero and be continuous');
    }
    if (index > 0) {
      const previous = headings[index - 1];
      if (heading.start < previous.end - EPSILON) {
        throw new Error('topic heading ranges overlap');
      }
      if (!sameTime(heading.start, previous.end)) {
        throw new Error('topic heading ranges must be continuous');
      }
    }
  }
  if (!sameTime(headings[headings.length - 1].end, duration)) {
    throw new Error('topic heading ranges must end at source duration and be continuous');
  }
  return headings.map(heading => ({ ...heading, title: heading.title.trim() }));
}

function pauseBefore(transcript: TranscriptSegment[], index: number): number {
  return Math.max(0, transcript[index].start - transcript[index - 1].end);
}

function fallbackTopicHeadings(transcript: TranscriptSegment[], duration: number): TopicHeading[] {
  if (duration <= 0) return [];
  if (duration <= MAX_TOPIC_SECONDS) {
    return [{ start: 0, end: duration, title: '主题 1' }];
  }

  const sorted = transcript
    .filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const boundaries: Array<{ time: number; pause: number }> = sorted
    .slice(1)
    .map((segment, index) => ({ time: segment.start, pause: pauseBefore(sorted, index + 1) }));
  const result: TopicHeading[] = [];
  let start = 0;

  while (duration - start > MAX_TOPIC_SECONDS) {
    const candidates = boundaries.filter(({ time }) => {
      const length = time - start;
      const remainder = duration - time;
      return length >= MIN_TOPIC_SECONDS
        && length <= MAX_TOPIC_SECONDS
        && remainder >= MIN_TOPIC_SECONDS;
    });
    let chosen = [...candidates].sort((left, right) =>
      right.pause - left.pause
      || Math.abs((left.time - start) - TARGET_TOPIC_SECONDS)
        - Math.abs((right.time - start) - TARGET_TOPIC_SECONDS)
      || left.time - right.time)[0];

    if (!chosen) {
      const hardCandidates = boundaries.filter(({ time }) =>
        time > start && time - start <= MAX_TOPIC_SECONDS);
      chosen = [...hardCandidates].sort((left, right) =>
        Math.abs((left.time - start) - TARGET_TOPIC_SECONDS)
          - Math.abs((right.time - start) - TARGET_TOPIC_SECONDS)
        || left.time - right.time)[0];
    }
    const end = chosen?.time
      ?? Math.min(start + TARGET_TOPIC_SECONDS, duration - MIN_TOPIC_SECONDS);
    if (end <= start + EPSILON) break;
    result.push({ start, end, title: `主题 ${result.length + 1}` });
    start = end;
  }
  if (start < duration) {
    result.push({ start, end: duration, title: `主题 ${result.length + 1}` });
  }
  return result;
}

function segmentIsValid(segment: TranscriptSegment, duration: number): boolean {
  return Number.isFinite(segment.start)
    && Number.isFinite(segment.end)
    && segment.start >= 0
    && segment.start < segment.end
    && segment.end <= duration + EPSILON
    && Boolean(segment.text.trim());
}

function findSection(sections: Section[], timestamp: number): Section | undefined {
  return sections.find((section, index) =>
    timestamp >= section.start
      && (timestamp < section.end
        || (index === sections.length - 1 && timestamp === section.end)));
}

function assignContent(
  sections: Section[],
  transcript: TranscriptSegment[],
  media: MediaAsset[],
  duration: number,
): { omitted: number[]; usedMediaIds: string[] } {
  const omitted: number[] = [];
  transcript.forEach((segment, index) => {
    if (!segmentIsValid(segment, duration)) {
      omitted.push(index);
      return;
    }
    // A segment is atomic: its start selects one [start, end) section, even
    // when the spoken sentence crosses a section boundary. Never duplicate it.
    const section = findSection(sections, segment.start);
    if (!section) {
      omitted.push(index);
      return;
    }
    section.transcript.push({ index, segment });
  });

  const usedMediaIds: string[] = [];
  for (const asset of media) {
    if (asset.timestampSec === undefined) continue;
    const section = findSection(sections, asset.timestampSec);
    if (!section) continue;
    const embed = handoutMediaEmbed(asset, asset.kind === 'slide' ? '课程页面' : '信息关键帧');
    if (!embed) continue;
    section.media.push(asset);
    usedMediaIds.push(asset.id);
  }
  return { omitted, usedMediaIds };
}

function transcriptMarkdown(segment: TranscriptSegment): string {
  const text = segment.text.trim();
  return segment.speaker ? `**${segment.speaker.trim()}：** ${text}` : text;
}

function renderHeader(source: ExtractedSource, duration: number, pageCount: number, editorialNote?: string): string[] {
  const author = source.source.author?.trim() || '未知';
  const publishedAt = source.source.publishedAt?.trim()
    ? source.source.publishedAt.trim().split('T', 1)[0]
    : '未知';
  const methods = [source.provenance.extractor, ...source.provenance.methods]
    .map(method => method.trim())
    .filter(Boolean);
  const lines = [
    `# ${source.source.title}（讲义）`,
    '',
    `> 作者：${author}｜发布日期：${publishedAt}｜总时长：${formatTime(duration)}｜页数：${pageCount}`,
    '>',
    `> 方法：${methods.length > 0 ? methods.join('；') : '未声明'}`,
  ];
  if (editorialNote?.trim()) {
    lines.push('>', `> 编辑说明：${editorialNote.replace(/\s+/g, ' ').trim()}`);
  }
  lines.push('', '---', '');
  return lines;
}

function renderSections(kind: 'slide' | 'topic', sections: Section[]): string[] {
  const lines: string[] = [];
  sections.forEach((section, index) => {
    const heading = kind === 'slide'
      ? `## 第 ${index + 1} 页 · ${formatTime(section.start)}–${formatTime(section.end)}（${Math.max(0, Math.round(section.end - section.start))}s）`
      : `## §${index + 1} · ${formatTime(section.start)}–${formatTime(section.end)} · ${section.title}`;
    lines.push(heading, '');
    for (const asset of section.media) {
      const embed = handoutMediaEmbed(asset, kind === 'slide' ? `第 ${index + 1} 页` : '信息关键帧');
      if (embed) lines.push(embed, '');
    }
    for (const { segment } of section.transcript) {
      lines.push(transcriptMarkdown(segment), '');
    }
  });
  return lines;
}

export function selectHandoutKind(source: ExtractedSource): 'slide' | 'topic' {
  return selectTimestampedSlides(source).length >= 2 ? 'slide' : 'topic';
}

export function formatHandout(source: ExtractedSource, options: HandoutOptions): HandoutResult {
  const kind = selectHandoutKind(source);
  const duration = validDuration(source);
  const warnings = [...source.warnings];
  const transcript = source.transcript ?? [];
  let sections: Section[];
  let media: MediaAsset[];
  let pageCount: number;

  if (kind === 'slide') {
    const slides = selectTimestampedSlides(source);
    const finalTimestamp = slides.at(-1)?.timestampSec as number;
    if (duration <= finalTimestamp) {
      throw new Error('source duration must end after the final slide timestamp');
    }
    sections = slides.map((slide, index) => ({
      start: slide.timestampSec as number,
      end: index + 1 < slides.length ? slides[index + 1].timestampSec as number : duration,
      title: `第 ${index + 1} 页`,
      media: [],
      transcript: [],
    }));
    media = slides;
    pageCount = slides.length;
  } else {
    const headings = options.topicHeadings.length > 0
      ? validateTopicHeadings(options.topicHeadings, duration)
      : fallbackTopicHeadings(transcript, duration);
    sections = headings.map(heading => ({
      ...heading,
      media: [],
      transcript: [],
    }));
    media = selectTimestampedFrames(source);
    pageCount = 0;
  }

  const { omitted, usedMediaIds } = assignContent(sections, transcript, media, duration);
  if (transcript.length === 0) warnings.push('transcript-empty');
  if (omitted.length > 0) warnings.push('incomplete-transcript-mapping');
  const markdown = [
    ...renderHeader(source, duration, pageCount, options.editorialNote),
    ...renderSections(kind, sections),
  ].join('\n').trimEnd() + '\n';

  return {
    kind,
    markdown,
    usedMediaIds,
    omittedTranscriptSegments: omitted,
    warnings: [...new Set(warnings)],
  };
}
