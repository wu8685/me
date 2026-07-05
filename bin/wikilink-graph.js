// bin/wikilink-graph.js — native wikilink graph engine
// Single-pass Node.js scanner: reads all .md files in configured layer dirs,
// extracts [[wikilinks]], produces a JSON graph.
//
// Output: { files: [...], links: {...}, broken: [...], orphans: [...], deadends: [...] }
//
// CLI usage: node bin/wikilink-graph.js [vault-dir]
// Module usage: const { buildGraph } = require('./bin/wikilink-graph.js')

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read .me/config.yaml from vaultDir and return layer directory mapping.
 * Falls back to defaults (raw, practices, cognition) if config is absent.
 */
function readConfig(vaultDir) {
  const cfgPath = path.join(vaultDir, '.me', 'config.yaml');
  if (!fs.existsSync(cfgPath)) {
    return { raw: 'raw', practices: 'practices', cognition: 'cognition' };
  }
  const text = fs.readFileSync(cfgPath, 'utf8');
  const raw = (text.match(/^\s+raw:\s*["']?([^"'\n]+)["']?/m) || [])[1] || 'raw';
  const practices = (text.match(/^\s+practices:\s*["']?([^"'\n]+)["']?/m) || [])[1] || 'practices';
  const cognition = (text.match(/^\s+cognition:\s*["']?([^"'\n]+)["']?/m) || [])[1] || 'cognition';
  return { raw: raw.trim(), practices: practices.trim(), cognition: cognition.trim() };
}

/**
 * Walk vaultDir scanning only the given layerDirs for .md files.
 * Returns:
 *   files: { lowercaseStem: relativePath }
 *   links: { relativePath: [lowercaseTarget, ...] }
 */
function scanVault(vaultDir, layerDirs) {
  const files = {};
  const links = {};

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const rel = path.relative(vaultDir, full);
      const stem = entry.name.replace(/\.md$/, '').toLowerCase();
      files[stem] = rel;
      const content = fs.readFileSync(full, 'utf8');
      // Extract targets from [[name]], [[name|alias]], [[name#heading]]
      links[rel] = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m =>
        m[1].split('|')[0].split('#')[0].trim().toLowerCase()
      );
    }
  }

  layerDirs.forEach(d => walk(path.join(vaultDir, d)));
  return { files, links };
}

/**
 * Build the full link graph for the vault at vaultDir.
 * Resolves layer directories from .me/config.yaml (defaults: raw, practices, cognition).
 */
function buildGraph(vaultDir) {
  const config = readConfig(vaultDir);
  const { files, links } = scanVault(vaultDir, Object.values(config));

  // Broken: link targets that don't resolve to any known file
  const broken = [];
  for (const [src, targets] of Object.entries(links)) {
    for (const t of targets) {
      if (!files[t]) broken.push({ source: src, target: t });
    }
  }

  // Orphans: files that no other file links to
  const incoming = {};
  for (const targets of Object.values(links)) {
    for (const t of targets) {
      incoming[t] = (incoming[t] || 0) + 1;
    }
  }
  const orphans = Object.values(files).filter(f =>
    !incoming[path.basename(f, '.md').toLowerCase()]
  );

  // Dead-ends: files with zero outgoing wikilinks
  const deadends = Object.entries(links)
    .filter(([, targets]) => targets.length === 0)
    .map(([f]) => f);

  return {
    files: Object.values(files),
    links,
    broken,
    orphans,
    deadends
  };
}

// CLI: node bin/wikilink-graph.js [vault-dir]
if (require.main === module) {
  const vaultDir = process.argv[2] || process.cwd();
  console.log(JSON.stringify(buildGraph(vaultDir), null, 2));
}

module.exports = { buildGraph };
