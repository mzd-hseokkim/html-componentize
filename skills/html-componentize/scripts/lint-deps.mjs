#!/usr/bin/env node
// PHASE 4.7 — Dependency-direction lint. Catch page→page coupling.
//
// A page/feature importing a component from ANOTHER feature's folder is a smell
// (that component should be hoisted to shared). Flags exactly those.
//
// Correctness rules (learned the hard way):
//   1. RESOLVE ALIAS imports (tsconfig paths / `@`→src) before checking — not
//      just relative imports, or real `@/...` page→page coupling is missed.
//   2. EXACT SEGMENT match — split on '/' and compare whole segments
//      (seg === 'common'); never substring (else 'view' ⊂ 'Preview' false-hits).
//   3. FEATURE boundary from config, not a hardcoded word list:
//      feature = first segment under a feature root that is NOT the sharedDir.
//
// Usage:
//   node lint-deps.mjs --root src --componentsDir src/components \
//        --sharedDir src/components/common [--config .componentize/config.json] \
//        --out .componentize/coupling-report.json

import { resolve, dirname, relative } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { parseArgs, readJSON, writeJSON } from './lib/domtree.mjs';

const args = parseArgs(process.argv.slice(2));
let cfg = {};
if (args.config) { try { cfg = await readJSON(resolve(args.config)); } catch {} }
const root = resolve(args.root || cfg.indexRoot || 'src');
const componentsDir = (args.componentsDir || cfg.componentsDir || 'src/components').replace(/\\/g, '/');
const sharedDir = (args.sharedDir || cfg.sharedDir || `${componentsDir}/common`).replace(/\\/g, '/');
const outPath = resolve(args.out || '.componentize/coupling-report.json');

const norm = (p) => p.replace(/\\/g, '/');
const relToCwd = (p) => norm(relative(process.cwd(), p));

// feature roots: dirs whose immediate child is a feature/page name
const FEATURE_ROOTS = [componentsDir, 'src/pages', 'src/features', 'src/views', 'src/routes', 'src/screens', 'pages', 'features']
  .map((p) => norm(resolve(p)));
const sharedAbs = norm(resolve(sharedDir));
// exact segment names that are ALWAYS shared (allowed import targets)
const SHARED_NAMES = new Set(['common', 'shared', 'ui', 'primitive', 'primitives', 'layout', 'layouts', 'lib', 'hooks', 'utils', 'icons', 'components']);

// ---- alias map from tsconfig/jsconfig paths (+ sensible defaults) --------
function stripJsonComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
}
const aliases = []; // { prefix, toAbs }  (wildcard prefixes, e.g. "@/" -> "<root>/src/")
let aliasBaseDir = resolve(root, '..'); // default project root guess
for (const tc of ['tsconfig.json', 'jsconfig.json']) {
  try {
    const raw = await readFile(resolve(process.cwd(), tc), 'utf8');
    const json = JSON.parse(stripJsonComments(raw));
    const co = json.compilerOptions || {};
    const baseDir = resolve(process.cwd(), co.baseUrl || '.');
    aliasBaseDir = baseDir;
    for (const [k, v] of Object.entries(co.paths || {})) {
      const target = Array.isArray(v) ? v[0] : v;
      if (!target) continue;
      aliases.push({ prefix: k.replace(/\*$/, ''), toAbs: norm(resolve(baseDir, target.replace(/\*$/, ''))) });
    }
  } catch { /* no/invalid tsconfig */ }
}
// common defaults if project didn't declare them
if (!aliases.some((a) => a.prefix === '@/')) aliases.push({ prefix: '@/', toAbs: norm(resolve(aliasBaseDir, 'src')) + '/' });
if (!aliases.some((a) => a.prefix === '~/')) aliases.push({ prefix: '~/', toAbs: norm(resolve(aliasBaseDir, 'src')) + '/' });

function resolveSpec(spec, fromFile) {
  if (spec.startsWith('.')) return norm(resolve(dirname(fromFile), spec));
  for (const a of aliases.sort((x, y) => y.prefix.length - x.prefix.length)) {
    if (spec.startsWith(a.prefix)) return norm(resolve(a.toAbs, spec.slice(a.prefix.length)));
  }
  return null; // bare import (node_modules / unknown) → ignore
}

// feature of an absolute path: { feature, shared } | null
function featureOf(absPath) {
  const p = norm(absPath);
  if (p.startsWith(sharedAbs + '/') || p === sharedAbs) return { shared: true };
  for (const rootDir of FEATURE_ROOTS) {
    if (p === rootDir || p.startsWith(rootDir + '/')) {
      const seg = p.slice(rootDir.length + 1).split('/')[0];
      if (!seg) return null;
      if (SHARED_NAMES.has(seg)) return { shared: true };
      return { feature: seg, shared: false };
    }
  }
  return null;
}

async function walk(dir, acc = []) {
  let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' || e.name === 'build') continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) await walk(full, acc);
    else if (/\.(tsx|jsx|vue|ts|js|mjs)$/.test(e.name)) acc.push(norm(full));
  }
  return acc;
}

const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const files = await walk(root);
const violations = [];
for (const file of files) {
  let code = ''; try { code = await readFile(file, 'utf8'); } catch { continue; }
  const fInfo = featureOf(file);
  if (!fInfo || fInfo.shared || !fInfo.feature) continue; // only feature-owned files can violate
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    const target = resolveSpec(spec, file);
    if (!target) continue;
    const tInfo = featureOf(target);
    if (tInfo && tInfo.feature && !tInfo.shared && tInfo.feature !== fInfo.feature) {
      violations.push({ from: relToCwd(file), importsFrom: relToCwd(target), spec, fromFeature: fInfo.feature, toFeature: tInfo.feature, fix: 'hoist the imported component to sharedDir, then import it from there' });
    }
  }
}

await writeJSON(outPath, { root: relToCwd(root), componentsDir, sharedDir, aliases: aliases.map((a) => `${a.prefix}→${relToCwd(a.toAbs)}`), ok: violations.length === 0, count: violations.length, violations });
console.log(JSON.stringify({ ok: violations.length === 0, out: outPath, violations: violations.length, sample: violations.slice(0, 8).map((v) => `${v.fromFeature} → ${v.toFeature} (${v.spec})`) }, null, 2));
process.exit(violations.length ? 1 : 0);
