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
  walk, structuralHash, structuralSignature, tagSignature, subtreeSize, classesIn,
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
// page chrome (→ shared layout) vs route-specific content
const CHROME_TAG = new Set(['header', 'footer', 'nav']);
const CHROME_CLASS = /\b(site-?header|site-?footer|app-?header|app-?footer|navbar|topbar|masthead|global-?nav|gnb|header|footer|sidebar)\b/i;
const CONTENT_CLASS = /\b(page-?content|main-?content|route|outlet|view|page-?body)\b/i;

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

// ---- load workspace index (optional) -----------------------------------
// Matching is layered, weakest signal alone never wins:
//   1) exact TAG signature (class-agnostic, so styles.x components match)
//   2) fuzzy: class-vocabulary overlap (Jaccard) + component-name match
// Mechanical match is only a CANDIDATE — the skill (LLM) confirms.
let indexByTagSig = new Map();
let indexComponents = [];
if (args.index) {
  try {
    const idx = await readJSON(resolve(args.index));
    indexComponents = idx.components || [];
    // SELF-REUSE GUARD: on re-conversion, exclude THIS page's own prior output
    // (manifest entries whose source === --self) so it regenerates instead of
    // matching itself as "reuse". Other pages' generated components still match.
    if (args.manifest && args.self) {
      try {
        const mf = await readJSON(resolve(args.manifest));
        const selfPaths = new Set(Object.entries(mf.files || {})
          .filter(([, v]) => v.source === args.self).map(([p]) => p.replace(/\\/g, '/')));
        if (selfPaths.size) indexComponents = indexComponents.filter((c) => !selfPaths.has((c.path || '').replace(/\\/g, '/')));
      } catch { /* no manifest */ }
    }
    for (const comp of indexComponents) {
      if (comp.tagSignature) indexByTagSig.set(comp.tagSignature, comp);
    }
  } catch { /* no index yet — fine for greenfield */ }
}

// canonicalize a class name so kebab/snake/camel/Pascal all compare equal:
//   card-title | card_title | cardTitle | CardTitle  →  "cardtitle"
function normClass(c) {
  return String(c)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camel boundaries
    .replace(/[-_]+/g, ' ')                 // kebab / snake → spaces
    .toLowerCase()
    .replace(/\s+/g, '');                   // join tokens
}
const normSet = (arr) => new Set((arr || []).map(normClass));

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// best reuse candidate for a node: returns { comp, score, reason } or null
function bestMatch(node, tagSig, name) {
  if (!indexComponents.length) return null;
  // 1) exact tag-structure match
  const exact = indexByTagSig.get(tagSig);
  if (exact) return { comp: exact, score: 1, reason: `exact tag-structure match` };
  // 2) fuzzy by class vocabulary + name
  const nodeClasses = normSet(classesIn(node));
  let best = null;
  for (const c of indexComponents) {
    const classScore = jaccard(nodeClasses, normSet(c.classes));
    const nameScore = c.name && c.name.toLowerCase() === name.toLowerCase() ? 1 : 0;
    const score = 0.65 * classScore + 0.35 * nameScore;
    if (score > 0 && (!best || score > best.score)) {
      best = { comp: c, score, reason: `class overlap ${(classScore * 100).toFixed(0)}%${nameScore ? ` + name match` : ''}` };
    }
  }
  return best && best.score >= 0.5 ? best : null;
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

  // 0) document root / body / html is always layout, never a component
  if (depth === 0 || node.tag === 'body' || node.tag === 'html') {
    classifications[node.uid] = {
      tag: node.tag, classes: node.classes, hash, size,
      label: 'layout', reason: 'document root / body — page host', confidence: 0.9, cssIntent: pr,
      suggestedName: nameFor(node),
    };
    return;
  }

  // 1) reuse — CANDIDATE match against an indexed existing component
  //    (exact tag-structure OR fuzzy class/name → model must confirm)
  const match = size >= 2 ? bestMatch(node, tagSig, nameFor(node)) : null;
  if (match) {
    label = 'reuse';
    reason = `matches existing component ${match.comp.name} (${match.comp.path}) — ${match.reason}; CONFIRM`;
    confidence = Math.min(0.85, 0.5 + match.score * 0.35);
    // ownership: shared dir → ok to import; page-owned → reusing it couples
    // pages, so flag for hoist-to-common
    const ownership = /(\/|^)(common|shared|ui|primitives?|layouts?)\//i.test(match.comp.path || '') ? 'shared' : 'page-owned';
    extra.matchedComponent = {
      name: match.comp.name, path: match.comp.path, props: match.comp.props,
      matchScore: Number(match.score.toFixed(2)), ownership, hoistCandidate: ownership === 'page-owned',
    };
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

  // shellRole — separates page CHROME (header/nav/footer, hoist into a shared
  // layout) from PAGE CONTENT (the route-specific region). Shallow nodes only;
  // the LLM uses this + detected routing to decide hoist vs inline.
  let shellRole;
  if (depth <= 2) {
    if (CHROME_TAG.has(node.tag) || node.classes.some((c) => CHROME_CLASS.test(c))) shellRole = 'chrome';
    else if (node.tag === 'main' || node.classes.some((c) => CONTENT_CLASS.test(c))) shellRole = 'page-content';
  }

  classifications[node.uid] = {
    tag: node.tag, classes: node.classes, hash, size,
    label, reason, confidence, cssIntent: pr, ...(shellRole ? { shellRole } : {}), ...extra,
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
