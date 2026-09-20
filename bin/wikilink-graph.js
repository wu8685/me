// bin/wikilink-graph.js — native semantic wikilink graph engine
//
// Source notes come from configured knowledge layers. Link targets resolve
// against the whole vault. Bare unresolved wikilinks remain useful virtual
// graph nodes; only unresolved concrete file/note references are broken.
//
// CLI usage: node bin/wikilink-graph.js [vault-dir]
// Module usage: const { buildGraph } = require('./bin/wikilink-graph.js')

'use strict';

const fs = require('fs');
const path = require('path');

const EXCLUDED_INVENTORY_DIRS = new Set([
  '.git', '.obsidian', '.me', '.planning', '.claude', '.codex', '.cache', 'node_modules'
]);

const CONCRETE_EXTENSIONS = new Set([
  '.md', '.pdf', '.json', '.csv', '.tsv',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif',
  '.mp3', '.wav', '.m4a', '.flac', '.ogg',
  '.mp4', '.mov', '.mkv', '.webm', '.avi'
]);

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

function toVaultPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function walkFiles(dir, accept, excludedDirs = new Set()) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedDirs.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && accept(entry.name)) results.push(full);
    }
  }

  walk(dir);
  return results;
}

function maskInlineCode(line) {
  return line.replace(/(`+)(.*?)\1/g, match => ' '.repeat(match.length));
}

function maskCode(content) {
  const lines = content.split('\n');
  let fence = null;

  return lines.map(line => {
    if (fence) {
      const closePattern = new RegExp(`^${fence.char}{${fence.length},}\\s*$`);
      if (closePattern.test(line.trim())) fence = null;
      return ' '.repeat(line.length);
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length };
      return ' '.repeat(line.length);
    }

    return maskInlineCode(line);
  }).join('\n');
}

function parseTarget(rawTarget) {
  return rawTarget.split('|')[0].split('#')[0].trim().replace(/\\/g, '/');
}

function isPlaceholder(target) {
  return target.includes('*') || /\$\{[^}]*\}/.test(target) || /<[^>]+>/.test(target);
}

function hasPathLikeSeparator(target) {
  return /[^\s][\\/][^\s]/.test(target);
}

function isConcreteReference(target, embed) {
  if (embed || hasPathLikeSeparator(target)) return true;
  const finalComponent = target.split('/').pop() || target;
  const extension = path.extname(finalComponent).toLowerCase();
  return CONCRETE_EXTENSIONS.has(extension) || /^\d{4}-\d{2}-\d{2}-.+/.test(finalComponent);
}

function buildInventory(vaultDir) {
  const paths = walkFiles(vaultDir, () => true, EXCLUDED_INVENTORY_DIRS)
    .map(full => toVaultPath(path.relative(vaultDir, full)));
  const exactPaths = new Map();
  const byName = new Map();

  function add(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }

  for (const relativePath of paths) {
    exactPaths.set(relativePath.toLowerCase(), relativePath);
    const filename = path.posix.basename(relativePath).toLowerCase();
    const extension = path.posix.extname(filename);
    add(byName, filename, relativePath);
    if (extension) add(byName, filename.slice(0, -extension.length), relativePath);
  }

  return { exactPaths, byName };
}

function safePathCandidate(candidate) {
  if (!candidate || path.posix.isAbsolute(candidate)) return null;
  const normalized = path.posix.normalize(candidate.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function resolveTarget(target, source, inventory) {
  const matches = new Set();
  const normalized = target.replace(/\\/g, '/');

  if (hasPathLikeSeparator(normalized)) {
    const sourceDir = path.posix.dirname(source);
    for (const candidate of [normalized, path.posix.join(sourceDir, normalized)]) {
      const safe = safePathCandidate(candidate);
      if (!safe) continue;
      for (const variant of [safe, path.posix.extname(safe) ? null : `${safe}.md`]) {
        if (!variant) continue;
        const existing = inventory.exactPaths.get(variant.toLowerCase());
        if (existing) matches.add(existing);
      }
    }
  }

  const lookup = normalized.toLowerCase();
  const basename = path.posix.basename(lookup);
  for (const key of new Set([lookup, basename])) {
    for (const existing of inventory.byName.get(key) || []) matches.add(existing);
    if (!path.posix.extname(key)) {
      for (const existing of inventory.byName.get(`${key}.md`) || []) matches.add(existing);
    }
  }

  return [...matches];
}

function extractOccurrences(source, content) {
  const occurrences = [];
  const ignored = [];
  const pattern = /(!)?\[\[([^\]]+)\]\]/g;

  for (const match of maskCode(content).matchAll(pattern)) {
    const target = parseTarget(match[2]);
    if (!target) continue;
    const occurrence = {
      source,
      target,
      normalizedTarget: target.toLowerCase(),
      embed: Boolean(match[1])
    };
    if (isPlaceholder(target)) ignored.push(occurrence);
    else occurrences.push(occurrence);
  }

  return { occurrences, ignored };
}

function buildGraph(vaultDir) {
  const config = readConfig(vaultDir);
  const inventory = buildInventory(vaultDir);
  const layerFiles = [];

  for (const layerDir of Object.values(config)) {
    for (const full of walkFiles(path.join(vaultDir, layerDir), name => name.endsWith('.md'))) {
      layerFiles.push(toVaultPath(path.relative(vaultDir, full)));
    }
  }

  const layerFileSet = new Set(layerFiles);
  const links = {};
  const broken = [];
  const virtual = [];
  const ignored = [];
  const incomingFiles = new Set();

  for (const source of layerFiles) {
    const fullPath = path.join(vaultDir, ...source.split('/'));
    const parsed = extractOccurrences(source, fs.readFileSync(fullPath, 'utf8'));
    links[source] = parsed.occurrences.map(item => item.normalizedTarget);
    ignored.push(...parsed.ignored);

    for (const occurrence of parsed.occurrences) {
      const resolvedPaths = resolveTarget(occurrence.target, source, inventory);
      if (resolvedPaths.length > 0) {
        for (const resolvedPath of resolvedPaths) {
          if (layerFileSet.has(resolvedPath)) incomingFiles.add(resolvedPath);
        }
      } else if (isConcreteReference(occurrence.target, occurrence.embed)) {
        broken.push(occurrence);
      } else {
        virtual.push(occurrence);
      }
    }
  }

  const orphans = layerFiles.filter(file => !incomingFiles.has(file));
  const deadends = layerFiles.filter(file => (links[file] || []).length === 0);
  return { files: layerFiles, links, broken, virtual, ignored, orphans, deadends };
}

if (require.main === module) {
  const vaultDir = process.argv[2] || process.cwd();
  console.log(JSON.stringify(buildGraph(vaultDir), null, 2));
}

module.exports = { buildGraph };
