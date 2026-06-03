#!/usr/bin/env node
// PHASE 2 — Classify boundaries. source-map.json → boundaries.json
//
// Heuristic FIRST PASS only. The skill (LLM) reviews and confirms; this script
// just grounds the proposal in mechanical signals so the LLM isn't guessing.
//
// Produces, per node, one label: layout | reuse | new-component | leaf-markup
// plus repetition groups (the join key is the structural hash, reused both for
// "these siblings repeat" AND "this matches an existing indexed component").
//
// Usage:
//   node detect-boundaries.mjs --in source-map.json --out boundaries.json \
//        [--index .componentize/workspace-index.json]

import { resolve } from 'node:path';
import {
  walk, structuralHash, structuralSignature, tagSignature, subtreeSize,
  parseArgs, readJSON, writeJSON,
} from './lib/domtree.mjs';

const args = parseArgs(process.argv.slice(2));
const inPath = resolve(args.in || '.componentize/source-map.json');
const outPath = resolve(args.out || '.componentize/boundaries.json');

const sm = await readJSON(inPath);
const tree = sm.tree;

// decls per uid (from authored CSS — used only to read INTENT, never to inline)
const declsByUid = new Map();
for (const r of sm.css.rules || []) {
  if (!r.matchedNodeIds) continue;
  for (const uid of r.matchedNodeIds) {
    if (!declsByUid.has(uid)) declsByUid.set(uid, []);
    declsByUid.get(uid).push(...(r.decls || []));
  }
}

const LAYOUT_PROPS = new Set([
  'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear',
  'flex', 'flex-direction', 'flex-wrap', 'flex-flow', 'justify-content',
  'align-items', 'align-content', 'align-self', 'gap', 'row-gap', 'column-gap',
  'grid', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
  'grid-column', 'grid-row', 'grid-auto-flow', 'place-items', 'place-content',
  'margin', 'padding', 'width', 'height', 'max-width', 'min-width',
  'max-height', 'min-height', 'overflow', 'overflow-x', 'overflow-y', 'box-sizing',
]);
const VISUAL_PROPS = new Set([
  'background', 'background-color', 'background-image', 'border', 'border-radius',
  'box-shadow', 'color', 'font', 'font-size', 'font-family', 'font-weight',
  'line-height', 'text-align', 'letter-spacing', 'opacity', 'fill', 'stroke',
]);
const LAYOUT_TAGS = new Set(['header', 'footer', 'nav', 'main', 'aside', 'section']);
const LAYOUT_CLASS = /\b(container|wrapper|row|col(umn)?|grid|layout|page|content|main|sidebar|header|footer|nav|section|inner|outer|flex)\b/i;
const LEAF_TAGS = new Set(['span', 'p', 'b', 'i', 'em', 'strong', 'small', 'br', 'hr', 'img', 'a', 'label', 'svg', 'path', 'code', 'time']);

const MIN_REPEAT = Number(args.minRepeat || 2);

function pascal(s) {
  return (s || 'Component').replace(/[^a-zA-Z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Component';
}
function nameFor(node) {
  return pascal(node.classes[0] || node.idAttr || node.tag);
}

function prosOf(node) {
  const decls = declsByUid.get(node.uid) || [];
  let layout = 0, visual = 0;
  for (const d of decls) {
    if (LAYOUT_PROPS.has(d.prop)) layout++;
    else if (VISUAL_PROPS.has(d.prop)) visual++;
  }
  return { layout, visual, total: decls.length };
}

// ---- load workspace index (optional) → signature hash map ---------------
// keyed on TAG signature (class-agnostic) so HTML literal classes can match
// compiled components that reference styles.x
let indexByTagSig = new Map();
if (args.index) {
  try {
    const idx = await readJSON(resolve(args.index));
    for (const comp of idx.components || []) {
      if (comp.tagSignature) indexByTagSig.set(comp.tagSignature, comp);
    }
  } catch { /* no index yet — fine for greenfield */ }
}

// ---- repetition groups --------------------------------------------------
const repetitionGroups = [];
walk(tree, (node) => {
  if (node.children.length < MIN_REPEAT) return;
  const byHash = new Map();
  for (const child of node.children) {
    const h = structuralHash(child);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(child);
  }
  for (const [h, items] of byHash) {
    if (items.length >= MIN_REPEAT && subtreeSize(items[0]) >= 1) {
      repetitionGroups.push({
        containerUid: node.uid,
        itemHash: h,
        count: items.length,
        itemUids: items.map((i) => i.uid),
        itemSize: subtreeSize(items[0]),
        itemSignature: structuralSignature(items[0]),
        suggestedItemName: nameFor(items[0]),
      });
    }
  }
});
const repeatedUids = new Set(repetitionGroups.flatMap((g) => g.itemUids));
const containerUids = new Set(repetitionGroups.map((g) => g.containerUid));

// ---- classification -----------------------------------------------------
const classifications = {};
walk(tree, (node, parent, depth) => {
  const hash = structuralHash(node);
  const tagSig = tagSignature(node);
  const size = subtreeSize(node);
  const pr = prosOf(node);
  let label, reason, confidence = 0.6;
  let extra = {};

  // 1) reuse — CANDIDATE match against an indexed existing component (tag-only
  //    signature → model must confirm; require non-trivial size to cut noise)
  const match = size >= 2 ? indexByTagSig.get(tagSig) : null;
  if (match) {
    label = 'reuse';
    reason = `tag-structure matches existing component ${match.name} (${match.path}) — CONFIRM`;
    confidence = 0.7;
    extra.matchedComponent = { name: match.name, path: match.path, props: match.props };
  }
  // 2) repeated item → new-component (the list item)
  else if (repeatedUids.has(node.uid)) {
    label = size >= 2 ? 'new-component' : 'leaf-markup';
    reason = `repeated ${repetitionGroups.find((g) => g.itemUids.includes(node.uid)).count}x within parent`;
    confidence = 0.85;
    extra.suggestedName = nameFor(node);
  }
  // 3) leaf markup
  else if (node.children.length === 0 || (LEAF_TAGS.has(node.tag) && size <= 2)) {
    label = 'leaf-markup';
    reason = 'leaf / inline element — keep as plain markup';
    confidence = 0.8;
  }
  // 4) layout — landmark tag or layout-class + positioning-dominant + not repeated
  else if (
    (LAYOUT_TAGS.has(node.tag) || node.classes.some((c) => LAYOUT_CLASS.test(c))) &&
    pr.layout >= pr.visual && size >= 3 && !containerUids.has(node.uid)
  ) {
    label = 'layout';
    reason = `landmark/layout class, positioning-dominant CSS (${pr.layout} layout vs ${pr.visual} visual), size ${size}`;
    confidence = 0.7;
    extra.suggestedName = nameFor(node);
  }
  // 5) list container that holds repeated items → layout (renders the .map)
  else if (containerUids.has(node.uid)) {
    label = 'layout';
    reason = 'container of a repetition group — host for list rendering';
    confidence = 0.75;
    extra.suggestedName = nameFor(node);
  }
  // 6) bounded visual unit → new-component
  else if (pr.visual >= 1 && size >= 3) {
    label = 'new-component';
    reason = `self-contained unit with visual identity (${pr.visual} visual props), size ${size}`;
    confidence = 0.6;
    extra.suggestedName = nameFor(node);
  }
  // 7) fallback
  else {
    label = depth <= 1 ? 'layout' : 'leaf-markup';
    reason = 'no strong signal — defaulted by depth';
    confidence = 0.4;
    if (label !== 'leaf-markup') extra.suggestedName = nameFor(node);
  }

  classifications[node.uid] = {
    tag: node.tag, classes: node.classes, hash, size,
    label, reason, confidence, cssIntent: pr, ...extra,
  };
});

const counts = {};
for (const c of Object.values(classifications)) counts[c.label] = (counts[c.label] || 0) + 1;

await writeJSON(outPath, {
  source: inPath,
  indexUsed: args.index ? resolve(args.index) : null,
  repetitionGroups,
  classifications,
  summary: { counts, repetitionGroups: repetitionGroups.length, reuseMatches: Object.values(classifications).filter((c) => c.label === 'reuse').length },
});

console.log(JSON.stringify({
  ok: true, out: outPath,
  counts,
  repetitionGroups: repetitionGroups.map((g) => ({ name: g.suggestedItemName, count: g.count, size: g.itemSize })),
  reuseMatches: Object.values(classifications).filter((c) => c.label === 'reuse').length,
  lowConfidence: Object.entries(classifications).filter(([, c]) => c.confidence < 0.5).map(([u]) => u).length,
}, null, 2));
