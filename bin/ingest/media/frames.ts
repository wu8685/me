import * as path from 'path';
import type { ExtractedSource, MediaAsset } from '../contracts.ts';

export function selectTimestampedSlides(source: ExtractedSource): MediaAsset[] {
  const slides = source.media.filter(asset => asset.kind === 'slide');
  const duration = source.source.durationSec;
  if (slides.length < 2) return [];
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) return [];
  if (slides.some(asset =>
    asset.timestampSec === undefined
    || !Number.isFinite(asset.timestampSec)
    || asset.timestampSec < 0
    || asset.timestampSec >= duration)) {
    return [];
  }
  for (let index = 1; index < slides.length; index += 1) {
    if ((slides[index].timestampSec as number) <= (slides[index - 1].timestampSec as number)) {
      return [];
    }
  }
  return slides;
}

export function selectTimestampedFrames(source: ExtractedSource): MediaAsset[] {
  return source.media
    .filter(asset => asset.kind === 'frame'
      && asset.timestampSec !== undefined
      && Number.isFinite(asset.timestampSec)
      && asset.timestampSec >= 0)
    .sort((left, right) => (left.timestampSec as number) - (right.timestampSec as number));
}

export function handoutMediaEmbed(
  asset: MediaAsset,
  fallbackAlt: string,
): string | undefined {
  const alt = (asset.alt || asset.caption || fallbackAlt).replace(/[\r\n\]]+/g, ' ').trim();
  const destination = (value: string) => `<${value.replace(
    /[\u0000-\u001f\u007f<>\\]/g,
    character => encodeURIComponent(character),
  )}>`;
  if (asset.path) {
    return `![${alt}](${destination(`slides/${path.basename(asset.path)}`)})`;
  }
  if (asset.url) {
    return `![${alt}](${destination(asset.url)})`;
  }
  return undefined;
}
