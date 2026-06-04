#!/usr/bin/env node
// PHASE 4.7 — Dependency-direction lint. Catch page→page coupling.
//
// After codegen, a page/feature importing a component from ANOTHER page's folder
// is a smell — that component should have been hoisted to shared/common. This
// flags exactly those imports so a missed hoist is visible immediately.
//
// Feature boundary = the segment after pages|features|views|routes. Shared dirs
// (common|shared|ui|primitives|layouts) are always allowed import targets.
//
// Usage:
//   node lint-deps.mjs --root src --out .componentize/coupling-report.json

import { resolve, dirname, relative } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { parseArgs, writeJSON } from './lib/domtree.mjs';

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root || 'src');
const outPath = resolve(args.out || '.componentize/coupling-report.json');

const FEATURE_SEG = /(pages?|features?|views?|routes?|screens?)/i;
const SHARED_SEG = /(common|shared|ui|primitives?|layouts?|lib|components\/common)/i;

async function walk(dir, acc = []) {
  let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' || e.name === 'build') continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) await walk(full, acc);
    else if (/\.(tsx|jsx|vue|ts|js)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

const norm = (p) => p.replace(/\\/g, '/');
const featureOf = (p) => {
  const segs = norm(p).split('/');
  const i = segs.findIndex((s) => FEATURE_SEG.test(s));
  return i >= 0 && segs[i + 1] ? segs[i + 1] : null;
};
const isShared = (p) => SHARED_SEG.test(norm(p));

const files = await walk(root);
const violations = [];
const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

for (const file of files) {
  let code = ''; try { code = await readFile(file, 'utf8'); } catch { continue; }
  const fFeat = featureOf(file);
  if (!fFeat || isShared(file)) continue; // only page/feature files can violate
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    const target = resolve(dirname(file), spec);
    const tFeat = featureOf(target);
    if (tFeat && tFeat !== fFeat && !isShared(target)) {
      violations.push({
        from: norm(relative(process.cwd(), file)),
        importsFrom: norm(relative(process.cwd(), target)),
        fromFeature: fFeat, toFeature: tFeat, spec,
        fix: `hoist the imported component to shared/common, then import it from there`,
      });
    }
  }
}

await writeJSON(outPath, { root: norm(relative(process.cwd(), root)), ok: violations.length === 0, count: violations.length, violations });
console.log(JSON.stringify({ ok: violations.length === 0, out: outPath, violations: violations.length,
  sample: violations.slice(0, 8).map((v) => `${v.fromFeature} → ${v.toFeature} (${v.spec})`) }, null, 2));
process.exit(violations.length ? 1 : 0);
