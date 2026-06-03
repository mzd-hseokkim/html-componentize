#!/usr/bin/env node
// PHASE 3 — Extract data. source-map.json + boundaries.json → data-spec.json
//
// For each repetition group, the item subtrees share a structural signature,
// so we walk them in LOCKSTEP. At each aligned position we compare text and
// attribute values across instances:
//   - identical across all instances  → static (stays in the template)
//   - differs                          → a prop / data field
// Field VALUES are copied verbatim from the source — never re-typed by an LLM.
//
// Usage:
//   node extract-data.mjs --map source-map.json --boundaries boundaries.json \
//        --out data-spec.json

import { resolve } from 'node:path';
import { walk, parseArgs, readJSON, writeJSON } from './lib/domtree.mjs';

const args = parseArgs(process.argv.slice(2));
const mapPath = resolve(args.map || '.componentize/source-map.json');
const bPath = resolve(args.boundaries || '.componentize/boundaries.json');
const outPath = resolve(args.out || '.componentize/data-spec.json');

const sm = await readJSON(mapPath);
const boundaries = await readJSON(bPath);

const byUid = new Map();
walk(sm.tree, (n) => byUid.set(n.uid, n));

function camel(s) {
  const p = (s || 'field').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return p.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('') || 'field';
}
function guessType(values) {
  if (values.every((v) => v !== '' && !Number.isNaN(Number(v)))) return 'number';
  if (values.every((v) => /^(https?:|\/|\.{0,2}\/|data:|#)/.test(v) || /\.(png|jpe?g|svg|gif|webp)$/i.test(v))) return 'string'; // url-ish
  return 'string';
}

// walk a set of aligned nodes in lockstep
function alignWalk(nodes, cb, path = []) {
  cb(nodes, path);
  const childCount = nodes[0].children.length;
  for (let i = 0; i < childCount; i++) {
    const childNodes = nodes.map((n) => n.children[i]);
    if (childNodes.every(Boolean)) alignWalk(childNodes, cb, [...path, i]);
  }
}

const groups = [];
for (const g of boundaries.repetitionGroups || []) {
  const nodes = g.itemUids.map((u) => byUid.get(u)).filter(Boolean);
  if (nodes.length < 2) continue;

  const fields = []; // { key, kind, path, type, samples }
  const usedKeys = new Set();
  const reserve = (base) => {
    let k = camel(base); let i = 2;
    while (usedKeys.has(k)) k = camel(base) + i++;
    usedKeys.add(k); return k;
  };

  alignWalk(nodes, (aligned, path) => {
    const ref = aligned[0];
    // text field
    const texts = aligned.map((n) => n.text);
    if (texts.some((t) => t !== texts[0]) && texts.some((t) => t !== '')) {
      fields.push({
        key: reserve(ref.classes[0] || ref.tag || 'text'),
        kind: 'text', path, type: guessType(texts), samples: texts,
      });
    }
    // attribute fields
    const attrKeys = new Set();
    aligned.forEach((n) => Object.keys(n.attrs).forEach((k) => attrKeys.add(k)));
    for (const attr of attrKeys) {
      const vals = aligned.map((n) => n.attrs[attr] ?? '');
      if (vals.some((v) => v !== vals[0])) {
        const hint = attr === 'src' ? 'image' : attr === 'href' ? 'href' : attr === 'alt' ? 'alt' : attr;
        fields.push({
          key: reserve(hint), kind: `attr:${attr}`, path, type: guessType(vals), samples: vals,
        });
      }
    }
  });

  // build the data array: one object per instance, values copied verbatim
  const data = nodes.map((_, instanceIdx) => {
    const row = {};
    for (const f of fields) row[f.key] = f.samples[instanceIdx];
    return row;
  });

  groups.push({
    containerUid: g.containerUid,
    itemHash: g.itemHash,
    count: g.count,
    componentName: g.suggestedItemName,
    props: fields.map((f) => ({ key: f.key, kind: f.kind, path: f.path, type: f.type })),
    data,
  });
}

await writeJSON(outPath, { source: { map: mapPath, boundaries: bPath }, groups });

console.log(JSON.stringify({
  ok: true, out: outPath,
  groups: groups.map((g) => ({ name: g.componentName, count: g.count, props: g.props.map((p) => `${p.key}:${p.type}`) })),
}, null, 2));
