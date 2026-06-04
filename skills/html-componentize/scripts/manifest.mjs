#!/usr/bin/env node
// PHASE 4.6 — Manifest. Snapshot what THIS plugin generated, so a later
// re-conversion knows what's safe to regenerate (overwrite), what was
// hand-edited since (reconcile), and what it never made (foreign — don't touch).
//
// Run AFTER codegen. Hashes every existing file in the file-plan and records it
// (merging with any prior manifest so multiple pages accumulate).
//
// Usage:
//   node manifest.mjs --plan .componentize/file-plan.json [--source page.html] \
//        --out .componentize/manifest.json

import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs, readJSON, writeJSON } from './lib/domtree.mjs';

const args = parseArgs(process.argv.slice(2));
const planPath = resolve(args.plan || '.componentize/file-plan.json');
const outPath = resolve(args.out || '.componentize/manifest.json');
const source = args.source || null;

const plan = await readJSON(planPath);
let manifest = { files: {} };
try { manifest = await readJSON(outPath); } catch { /* first run */ }
if (!manifest.files) manifest.files = {};

// collect every planned file path (components + hoisted layout)
const entries = [];
for (const c of plan.components || []) {
  for (const p of Object.values(c.files || {})) entries.push({ path: p, component: c.name });
}
if (plan.layout && plan.layout.component) {
  for (const p of Object.values(plan.layout.component.files || {})) entries.push({ path: p, component: plan.layout.component.name });
}

let recorded = 0, missing = 0;
for (const { path, component } of entries) {
  try {
    const hash = createHash('sha1').update(await readFile(resolve(path))).digest('hex');
    manifest.files[path] = { hash, component, source: source || (manifest.files[path] && manifest.files[path].source) || null, generatedBy: 'html-componentize' };
    recorded++;
  } catch { missing++; /* not written (e.g. reuse) — skip */ }
}

await writeJSON(outPath, manifest);
console.log(JSON.stringify({ ok: true, out: outPath, recorded, missing, totalTracked: Object.keys(manifest.files).length, source }, null, 2));
