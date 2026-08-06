/**
 * Read-only path helpers for me:recall. Never creates directories.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Canonicalize a path; when realpath fails, fall back to the absolute lexical form. */
export function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `child` is `parent` or a descendant of `parent` (canonicalized). */
export function isPathWithin(child: string, parent: string): boolean {
  const c = canonicalize(child);
  const p = canonicalize(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : `${p}${path.sep}`);
}
