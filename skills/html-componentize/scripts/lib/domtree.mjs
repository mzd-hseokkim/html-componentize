// Shared DOM-tree utilities for the componentize engine.
// Source of truth = authored HTML/CSS. We NEVER read computed style here.
import { createHash } from 'node:crypto';

export const UID_ATTR = 'data-cz-uid';

/**
 * Build a plain JSON tree from a cheerio root, tagging every element with a
 * stable uid (also written back onto the cheerio DOM as data-cz-uid so CSS
 * selector matching can map rules → nodes).
 *
 * Node shape: { uid, tag, classes[], idAttr, attrs{}, text, children[] }
 *  - text: direct (non-whitespace) text content of THIS node only, verbatim.
 *  - attrs excludes class/id/style and the uid attr.
 */
export function buildTree($, el, counter = { n: 0 }) {
  const uid = `n${counter.n++}`;
  $(el).attr(UID_ATTR, uid);

  const classAttr = ($(el).attr('class') || '').trim();
  const classes = classAttr ? classAttr.split(/\s+/) : [];
  const idAttr = $(el).attr('id') || null;

  const attrs = {};
  const raw = el.attribs || {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'class' || k === 'id' || k === 'style' || k === UID_ATTR) continue;
    attrs[k] = v;
  }

  // direct text only (verbatim — never rewritten)
  let text = '';
  for (const child of el.children || []) {
    if (child.type === 'text') text += child.data;
  }
  text = text.replace(/\s+/g, ' ').trim();

  const children = [];
  for (const child of el.children || []) {
    if (child.type === 'tag') children.push(buildTree($, child, counter));
  }

  return { uid, tag: el.name, classes, idAttr, attrs, text, children };
}

/** Walk a tree depth-first, calling fn(node, parent, depth). */
export function walk(node, fn, parent = null, depth = 0) {
  fn(node, parent, depth);
  for (const child of node.children) walk(child, fn, node, depth + 1);
}

/**
 * Structural signature: captures tag + sorted-class shape RECURSIVELY,
 * ignoring text content and attribute *values*. Two subtrees with the same
 * signature are structurally identical → repetition candidates, and the same
 * key is used to match against indexed existing components.
 */
export function structuralSignature(node) {
  const self = `${node.tag}.${[...node.classes].sort().join('.')}`;
  if (node.children.length === 0) return self;
  const kids = node.children.map(structuralSignature).join(',');
  return `${self}(${kids})`;
}

export function structuralHash(node) {
  return createHash('sha1').update(structuralSignature(node)).digest('hex').slice(0, 12);
}

/**
 * Tag-only signature: structure ignoring classes AND text. Used as the
 * cross-artifact REUSE join key — HTML carries literal classes but compiled
 * components reference styles.x, so a class-inclusive key would never match.
 * Weaker (more false positives) → treated as a CANDIDATE the model confirms.
 */
export function tagSignature(node) {
  if (node.children.length === 0) return node.tag;
  return `${node.tag}(${node.children.map(tagSignature).join(',')})`;
}

/** Count total element nodes in a subtree. */
export function subtreeSize(node) {
  let n = 1;
  for (const c of node.children) n += subtreeSize(c);
  return n;
}

/** All distinct class names used in a subtree. */
export function classesIn(node) {
  const set = new Set();
  walk(node, (n) => n.classes.forEach((c) => set.add(c)));
  return [...set];
}

/** Find a node by uid. */
export function findByUid(node, uid) {
  let found = null;
  walk(node, (n) => { if (n.uid === uid) found = n; });
  return found;
}

/** Read a JSON file. */
export async function readJSON(path) {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(path, 'utf8'));
}

/** Write a JSON artifact (pretty). */
export async function writeJSON(path, data) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
}

/** Minimal CLI arg parser: --key value / --flag. */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; }
      else { args[key] = next; i++; }
    } else { args._.push(a); }
  }
  return args;
}
