/**
 * Deterministic redaction for me:recall session evidence.
 *
 * Every pattern maps to a fixed `[REDACTED:<type>]` token so the same input
 * always produces the same output (pure function). Redaction is heuristic by
 * design — it errs toward privacy: over-redaction of a benign token is
 * acceptable, a leaked credential is not.
 */

import type { RedactResult } from './contracts';

interface RedactionRule {
  type: string;
  re: RegExp;
  replacement: string;
}

const RULES: RedactionRule[] = [
  // Private key blocks first so an env assignment wrapping one doesn't pre-empt.
  {
    type: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
  },
  // URL credentials: https://user:pass@host -> https://[REDACTED:credential]@host
  {
    type: 'credential',
    re: /(\bhttps?:\/\/)([^/@\s]+):([^/@\s]+)@/g,
    replacement: '$1[REDACTED:credential]@',
  },
  // Authorization headers.
  {
    type: 'header',
    re: /(\bauthorization\s*[:=]\s*)\S+/gi,
    replacement: '$1[REDACTED:header]',
  },
  // Bearer tokens.
  {
    type: 'api-key',
    re: /(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    replacement: '$1[REDACTED:api-key]',
  },
  // Well-known API key prefixes.
  {
    type: 'api-key',
    re: /(\b)(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{10,})(\b)/g,
    replacement: '$1[REDACTED:api-key]$3',
  },
  // Emails.
  {
    type: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: '[REDACTED:email]',
  },
  // SCREAMING_CASE=value env assignments (keeps the variable name).
  {
    type: 'env-value',
    re: /((?:^|[\s;&|])(?:export\s+)?)([A-Z][A-Z0-9_]{2,})=(?:"[^"]*"|'[^']*'|[^\s;&|]+)/g,
    replacement: '$1$2=[REDACTED:env-value]',
  },
  // ${VAR} env references.
  {
    type: 'env',
    re: /\$\{[A-Z][A-Z0-9_]{0,31}\}/g,
    replacement: '[REDACTED:env]',
  },
  // $VAR env references (not preceded by a word char or $).
  {
    type: 'env',
    re: /(?<![\w$])\$[A-Z][A-Z0-9_]{2,}\b/g,
    replacement: '[REDACTED:env]',
  },
  // IPv4.
  {
    type: 'ip-address',
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: '[REDACTED:ip-address]',
  },
  // MAC addresses.
  {
    type: 'mac-address',
    re: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g,
    replacement: '[REDACTED:mac-address]',
  },
  // Long mixed-case alphanumeric tokens that look like secrets (>= 24 chars,
  // at least one uppercase letter and one digit). Lowercase identifiers such as
  // commit SHAs and session ids are left intact.
  {
    type: 'secret',
    re: /\b(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{24,}\b/g,
    replacement: '[REDACTED:secret]',
  },
];

export function redactText(input: string): RedactResult {
  let text = input;
  const tokens: Record<string, number> = {};
  for (const rule of RULES) {
    const matches = text.match(rule.re);
    if (matches && matches.length > 0) {
      tokens[rule.type] = (tokens[rule.type] || 0) + matches.length;
      text = text.replace(rule.re, rule.replacement);
    }
  }
  return { text, redacted: text !== input, tokens };
}
