#!/usr/bin/env node
// PHASE 1 — Parse. HTML + CSS → source-map.json
//
// Deterministic. Builds the DOM tree, parses authored CSS into rules (kept
// INTACT — never recomputed), maps which rules match which nodes (for later
// scoping), and inventories assets.
//
// Usage:
//   node parse-source.mjs --html page.html [--css a.css --css b.css] \
//                         --out .componentize/source-map.json
//
// If no --css is given, inline <style> blocks and <link rel=stylesheet> hrefs
// (resolved relative to the html file) are used.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as cheerio from 'cheerio';
import postcss from 'postcss';
import { buildTree, walk, UID_ATTR, parseArgs, writeJSON } from './lib/domtree.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.html) {
  console.error('error: --html <file> required');
  process.exit(2);
}
const htmlPath = resolve(args.html);
const baseDir = dirname(htmlPath);
const outPath = resolve(args.out || '.componentize/source-map.json');
const cssArgs = [].concat(args.css || []).filter((x) => typeof x === 'string');

const html = await readFile(htmlPath, 'utf8');
const $ = cheerio.load(html, { sourceCodeLocationInfo: false });

// ---- collect CSS sources (verbatim) ------------------------------------
const cssSources = []; // { origin, css }
if (cssArgs.length) {
  for (const c of cssArgs) {
    const p = resolve(c);
    cssSources.push({ origin: c, css: await readFile(p, 'utf8') });
  }
} else {
  $('style').each((i, el) => {
    cssSources.push({ origin: `inline:style[${i}]`, css: $(el).text() });
  });
  const links = [];
  $('link[rel="stylesheet"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href && !/^https?:/i.test(href)) links.push(href);
  });
  for (const href of links) {
    try {
      cssSources.push({ origin: href, css: await readFile(resolve(baseDir, href), 'utf8') });
    } catch {
      cssSources.push({ origin: href, css: '', missing: true });
    }
  }
}

// ---- parse CSS into a flat rule list (rules kept intact) ----------------
const rules = []; // { origin, selector, media, decls:[{prop,value}], raw }
for (const { origin, css } of cssSources) {
  if (!css) continue;
  let root;
  try { root = postcss.parse(css); } catch (e) {
    rules.push({ origin, parseError: String(e.message || e) });
    continue;
  }
  root.walkRules((rule) => {
    const media = rule.parent && rule.parent.type === 'atrule' && rule.parent.name === 'media'
      ? `@media ${rule.parent.params}` : null;
    const decls = [];
    rule.walkDecls((d) => decls.push({ prop: d.prop, value: d.value }));
    // split grouped selectors so each maps independently
    for (const sel of rule.selector.split(',').map((s) => s.trim()).filter(Boolean)) {
      rules.push({ origin, selector: sel, media, decls, raw: rule.toString() });
    }
  });
}

// ---- build DOM tree (root = <body> if present, else document root) -----
const bodyEl = $('body')[0] || $.root().children().toArray().find((e) => e.type === 'tag');
const tree = buildTree($, bodyEl);

// ---- map rules → matching node uids (best-effort) -----------------------
// We only match the compound part before pseudos so :hover etc. still map.
for (const r of rules) {
  if (r.parseError) continue;
  const base = r.selector.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim() || r.selector;
  const uids = [];
  try {
    $(base).each((i, el) => {
      const uid = el.attribs && el.attribs[UID_ATTR];
      if (uid) uids.push(uid);
    });
  } catch { /* unsupported selector — leave unmatched */ }
  r.matchedNodeIds = uids;
}

// ---- class inventory ----------------------------------------------------
const classSet = new Set();
walk(tree, (n) => n.classes.forEach((c) => classSet.add(c)));

// ---- asset inventory ----------------------------------------------------
const assets = { images: [], scripts: [], stylesheets: [], fonts: [] };
$('img[src]').each((i, el) => assets.images.push($(el).attr('src')));
$('script[src]').each((i, el) => assets.scripts.push($(el).attr('src')));
$('link[rel="stylesheet"][href]').each((i, el) => assets.stylesheets.push($(el).attr('href')));
for (const { css } of cssSources) {
  for (const m of (css || '').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    const u = m[1];
    if (/\.(woff2?|ttf|otf|eot)(\?|$)/i.test(u)) assets.fonts.push(u);
    else assets.images.push(u);
  }
}
for (const k of Object.keys(assets)) assets[k] = [...new Set(assets[k])];

// ---- interaction sniffing (flag, don't guess) ---------------------------
const interactions = [];
walk(tree, (n) => {
  for (const [k, v] of Object.entries(n.attrs)) {
    if (/^on[a-z]+$/.test(k)) interactions.push({ uid: n.uid, type: 'inline-handler', attr: k, code: v });
  }
});
const scriptBlocks = [];
$('script:not([src])').each((i, el) => {
  const code = $(el).text().trim();
  if (code) scriptBlocks.push({ index: i, length: code.length });
});

await writeJSON(outPath, {
  source: { htmlFile: args.html, cssSources: cssSources.map((c) => ({ origin: c.origin, missing: !!c.missing })) },
  tree,
  css: { rules },
  classInventory: [...classSet].sort(),
  assets,
  interactions: { inline: interactions, scriptBlocks },
});

console.log(JSON.stringify({
  ok: true,
  out: outPath,
  nodes: classSet.size === undefined ? 0 : (() => { let n = 0; walk(tree, () => n++); return n; })(),
  cssRules: rules.length,
  classes: classSet.size,
  assets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, v.length])),
  interactionsFlagged: interactions.length + scriptBlocks.length,
}, null, 2));
