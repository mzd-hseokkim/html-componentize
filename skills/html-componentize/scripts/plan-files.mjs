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
import { createHash } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
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
const layoutStrategy = args.layoutStrategy || cfg.layoutStrategy || 'inline'; // reuse-layout | hoist | inline
const routing = cfg.routing || { library: null, outlet: null, hasLayout: false, layoutPath: null };

// Existing layout discovery is LAYERED: detect-project's hardcoded path is just
// a fast-path hint. The authoritative source is the SCANNED workspace index —
// any component with kind 'layout' (found by name, not a hardcoded path). This
// catches non-standard layouts (src/shell/RootShell.tsx etc.) the path list misses.
let indexLayout = null;
{
  const idxPath = resolve(args.index || '.componentize/workspace-index.json');
  try {
    const idx = await readJSON(idxPath);
    indexLayout = (idx.components || []).find((c) => c.kind === 'layout') || null;
  } catch { /* no index */ }
}
if (!routing.layoutPath && indexLayout) { routing.layoutPath = indexLayout.path; routing.hasLayout = true; routing.layoutSource = 'workspace-index'; }

const boundaries = await readJSON(bPath);
const dataSpec = await (async () => { try { return await readJSON(dPath); } catch { return { groups: [] }; } })();

// ---- idempotent re-conversion: classify each target file's write mode ----
// manifest records what WE generated (path → hash). On re-run:
//   create     — no file there → write fresh
//   overwrite  — exists, ours, unchanged since we made it → safe to regenerate
//   reconcile  — exists, ours, but HAND-EDITED since → surgical update + diff
//   foreign    — exists, NOT ours → never blind-overwrite; surface to the user
const manifestPath = resolve(args.manifest || '.componentize/manifest.json');
let manifest = { files: {} };
try { manifest = await readJSON(manifestPath); } catch { /* first run */ }
async function classifyFile(relPath) {
  let cur = null;
  try { cur = createHash('sha1').update(await fsReadFile(resolve(relPath))).digest('hex'); } catch { return 'create'; }
  const rec = manifest.files && manifest.files[relPath];
  if (!rec) return 'foreign';
  return rec.hash === cur ? 'overwrite' : 'reconcile';
}

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

const components = [];
for (const comp of comps.values()) {
  const dir = dirFor(comp);
  const files = {
    component: `${dir}/${comp.name}.${compExt}`,
    styles: `${dir}/${comp.name}.module.css`,
  };
  if (structure !== 'flat') files.index = `${dir}/index.${codeExt}`;
  if (comp.hasData) files.data = `${dir}/${comp.dataName}.data.${codeExt}`;
  const writeMode = await classifyFile(files.component);
  components.push({ name: comp.name, kind: comp.kind, dir, files, writeMode, classes: comp.classes, imports: comp.imports, sourceUids: comp.uids });
}

// ---- layout plan: separate page CHROME from route content ---------------
// chrome (header/nav/footer) → shared layout + outlet, not duplicated per page.
const chrome = Object.entries(boundaries.classifications)
  .filter(([, c]) => c.shellRole === 'chrome')
  .map(([uid, c]) => ({ uid, tag: c.tag, name: c.suggestedName || c.tag, classes: c.classes }));
const contentNode = Object.entries(boundaries.classifications)
  .find(([, c]) => c.shellRole === 'page-content');

// if an existing layout is known (hint OR index), prefer reusing it over hoisting
const effectiveStrategy = (layoutStrategy !== 'inline' && routing.layoutPath) ? 'reuse-layout' : layoutStrategy;

let layout;
if (chrome.length === 0 || effectiveStrategy === 'inline') {
  layout = { strategy: 'inline', note: 'no routing/layout — chrome stays in the page component' };
} else if (effectiveStrategy === 'reuse-layout' && routing.layoutPath) {
  layout = {
    strategy: 'reuse-layout',
    existingLayout: routing.layoutPath,
    layoutSource: routing.layoutSource || 'convention-path',
    outlet: routing.outlet,
    chrome: chrome.map((c) => c.name),
    instruction: `Do NOT regenerate chrome. The page renders ONLY its content (${contentNode ? contentNode[1].suggestedName || 'main' : 'main'}) into the existing layout's outlet (${routing.outlet || 'VERIFY: open the layout file and find its outlet'}). Reconcile chrome only if the existing layout lacks it.`,
  };
} else { // hoist
  const dir = structure === 'flat' ? outDir : `${outDir}/Layout`;
  layout = {
    strategy: 'hoist',
    component: { name: 'Layout', dir, files: { component: `${dir}/Layout.${compExt}`, styles: `${dir}/Layout.module.css`, ...(structure !== 'flat' ? { index: `${dir}/index.${codeExt}` } : {}) } },
    outlet: routing.outlet || (framework === 'vue' ? '<router-view/> or <slot/>' : '<Outlet/>'),
    chrome: chrome.map((c) => c.name),
    routerLibrary: routing.library,
    instruction: `Generate a shared Layout containing the chrome (${chrome.map((c) => c.name).join(', ') || 'header/footer'}) with an outlet where route content renders. The page becomes a ROUTE component holding only its content — not the chrome. Wire it per ${routing.library || 'the router'}.`,
  };
}

if (layout.component) layout.writeMode = await classifyFile(layout.component.files.component);

const modeCounts = {};
for (const c of components) modeCounts[c.writeMode] = (modeCounts[c.writeMode] || 0) + 1;
const reconvert = {
  isReconversion: components.some((c) => c.writeMode !== 'create'),
  modes: modeCounts,
  foreign: components.filter((c) => c.writeMode === 'foreign').map((c) => c.files.component),
  reconcile: components.filter((c) => c.writeMode === 'reconcile').map((c) => c.files.component),
  manifest: manifestPath,
};

await writeJSON(outPath, { framework, lang, outDir, structure, layoutStrategy, routing, layout, reconvert, components });

console.log(JSON.stringify({
  ok: true, out: outPath, framework, lang, structure, outDir,
  layout: { strategy: layout.strategy, chrome: layout.chrome || [], outlet: layout.outlet || null, existingLayout: layout.existingLayout || null },
  reconvert,
  components: components.map((c) => ({ name: c.name, kind: c.kind, dir: c.dir, writeMode: c.writeMode, imports: c.imports.map((i) => `${i.name}:${i.kind}`) })),
}, null, 2));
