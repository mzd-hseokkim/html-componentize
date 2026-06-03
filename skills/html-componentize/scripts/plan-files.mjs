#!/usr/bin/env node
// PHASE 4 (layout) — plan-files. boundaries + data-spec → file-plan.json
//
// Codegen used to dump everything flat. This derives a directory HIERARCHY for
// the components from the boundary tree (containment) + repetition groups, so
// the skill can lay out real folders instead of a flat pile.
//
// Structures (--structure):
//   co-location (default) — one folder per component:
//        <outDir>/Card/{ Card.tsx, Card.module.css, index.ts }
//        <outDir>/CardGrid/{ CardGrid.tsx, CardGrid.module.css, cards.data.ts, index.ts }
//   nested — item folder lives inside its container's folder:
//        <outDir>/CardGrid/{ CardGrid.tsx, ... , Card/{ Card.tsx, ... } }
//   flat — files directly in <outDir> (legacy).
//
// Usage:
//   node plan-files.mjs --boundaries boundaries.json --data data-spec.json \
//        --config .componentize/config.json --out .componentize/file-plan.json
//   (framework/lang/outDir/structure read from config; override with flags)

import { resolve } from 'node:path';
import { parseArgs, readJSON, writeJSON } from './lib/domtree.mjs';

const args = parseArgs(process.argv.slice(2));
const bPath = resolve(args.boundaries || '.componentize/boundaries.json');
const dPath = resolve(args.data || '.componentize/data-spec.json');
const outPath = resolve(args.out || '.componentize/file-plan.json');

let cfg = {};
if (args.config) { try { cfg = await readJSON(resolve(args.config)); } catch {} }
const framework = args.framework || cfg.framework || 'react';
const lang = args.lang || cfg.lang || 'ts';
const outDir = (args.outDir || cfg.outDir || 'src/components/generated').replace(/\\/g, '/').replace(/\/$/, '');
const structure = args.structure || cfg.structure || 'co-location';

const boundaries = await readJSON(bPath);
const dataSpec = await (async () => { try { return await readJSON(dPath); } catch { return { groups: [] }; } })();

const compExt = framework === 'vue' ? 'vue' : (lang === 'ts' ? 'tsx' : 'jsx');
const codeExt = lang === 'ts' ? 'ts' : 'js';
const camel = (s) => s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
  .map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase()).join('') || 'data';

const dataByContainer = new Map(); // containerUid -> data group
for (const g of dataSpec.groups || []) dataByContainer.set(g.containerUid, g);

// ---- collect components from the boundary tree --------------------------
// containers (render a list) + their item components, then standalone units.
const comps = new Map(); // name -> { name, kind, classes, hasData, dataName, imports[], uids[] }
function ensure(name, init) {
  if (!comps.has(name)) comps.set(name, { name, kind: 'component', classes: [], hasData: false, imports: [], uids: [], ...init });
  return comps.get(name);
}

const containerNameByUid = new Map();
for (const g of boundaries.repetitionGroups || []) {
  const cinfo = boundaries.classifications[g.containerUid] || {};
  const containerName = cinfo.suggestedName || `${g.suggestedItemName}List`;
  containerNameByUid.set(g.containerUid, containerName);
  const item = ensure(g.suggestedItemName, { kind: 'component', classes: cinfo.classes || [], uids: [...g.itemUids] });
  const dataGroup = dataByContainer.get(g.containerUid);
  const container = ensure(containerName, {
    kind: 'layout',
    classes: cinfo.classes || [],
    uids: [g.containerUid],
    hasData: !!dataGroup,
    dataName: dataGroup ? `${camel(g.suggestedItemName)}s` : null,
  });
  // container imports the item component (+ its data file)
  if (!container.imports.find((i) => i.name === item.name)) container.imports.push({ name: item.name, kind: 'component' });
  if (dataGroup) container.imports.push({ name: container.dataName, kind: 'data' });
}

const repeatedUids = new Set((boundaries.repetitionGroups || []).flatMap((g) => g.itemUids));
const containerUids = new Set((boundaries.repetitionGroups || []).map((g) => g.containerUid));
for (const [uid, c] of Object.entries(boundaries.classifications)) {
  if (c.label !== 'new-component') continue;
  if (repeatedUids.has(uid) || containerUids.has(uid)) continue; // already handled
  const name = c.suggestedName || 'Component';
  ensure(name, { kind: 'component', classes: c.classes || [], uids: [uid] });
}

// ---- compute file paths per structure -----------------------------------
function dirFor(comp) {
  if (structure === 'flat') return outDir;
  if (structure === 'nested' && comp.kind === 'component') {
    // place item inside the container that imports it, if any
    const parent = [...comps.values()].find((c) => c.imports.some((i) => i.kind === 'component' && i.name === comp.name));
    if (parent) return `${outDir}/${parent.name}/${comp.name}`;
  }
  return `${outDir}/${comp.name}`;
}

const components = [...comps.values()].map((comp) => {
  const dir = dirFor(comp);
  const files = {
    component: `${dir}/${comp.name}.${compExt}`,
    styles: `${dir}/${comp.name}.module.css`,
  };
  if (structure !== 'flat') files.index = `${dir}/index.${codeExt}`;
  if (comp.hasData) files.data = `${dir}/${comp.dataName}.data.${codeExt}`;
  return { name: comp.name, kind: comp.kind, dir, files, classes: comp.classes, imports: comp.imports, sourceUids: comp.uids };
});

await writeJSON(outPath, { framework, lang, outDir, structure, components });

console.log(JSON.stringify({
  ok: true, out: outPath, framework, lang, structure, outDir,
  components: components.map((c) => ({ name: c.name, kind: c.kind, dir: c.dir, files: Object.values(c.files).length, imports: c.imports.map((i) => `${i.name}:${i.kind}`) })),
}, null, 2));
