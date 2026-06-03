#!/usr/bin/env node
// PHASE 0.5 — Index workspace. Scan target → workspace-index.json
//
// Builds the LIVING index of existing + generated components so conversion
// REUSES them instead of regenerating (no duplicate Buttons across pages).
// The key trick: we derive the SAME structural signature used by phase 2's
// repetition detection, so matching is a hash lookup, not an LLM guess.
//
// React/TSX/JSX: parsed with @babel/parser. Vue SFC: template parsed as HTML
// (reusing our signature fn). Props are best-effort; the skill (LLM) confirms.
//
// Usage:
//   node index-workspace.mjs --root src --out .componentize/workspace-index.json
//        [--tag existing|generated]

import { resolve, relative, basename, extname } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import * as babelParser from '@babel/parser';
import _traverse from '@babel/traverse';
import { buildTree, structuralSignature, tagSignature, parseArgs, writeJSON } from './lib/domtree.mjs';

const traverse = _traverse.default || _traverse;
const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root || 'src');
const outPath = resolve(args.out || '.componentize/workspace-index.json');
const tag = args.tag || 'existing';

async function walkDir(dir, acc = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) await walkDir(full, acc);
    else if (/\.(tsx|jsx|vue)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

function pascalFromFile(file) {
  const b = basename(file, extname(file));
  if (b.toLowerCase() === 'index') return basename(resolve(file, '..'));
  return b;
}
const LAYOUT_NAME = /(layout|shell|page|wrapper|container|scaffold|app)$/i;

// ---- JSX → signature + props (best effort) ------------------------------
// pull class names out of a className value: "a b", styles.card, styles['x'],
// `${styles.a} b`, clsx(styles.a, 'b') — best-effort, collects every literal/
// CSS-module member it can see.
function classesFromExpr(node, acc) {
  if (!node) return;
  switch (node.type) {
    case 'StringLiteral': node.value.trim().split(/\s+/).filter(Boolean).forEach((c) => acc.add(c)); break;
    case 'MemberExpression': // styles.card
      if (node.property && !node.computed && node.property.name) acc.add(node.property.name);
      else if (node.computed && node.property && node.property.type === 'StringLiteral') acc.add(node.property.value);
      break;
    case 'TemplateLiteral':
      node.quasis.forEach((q) => q.value.cooked.trim().split(/\s+/).filter(Boolean).forEach((c) => acc.add(c)));
      node.expressions.forEach((e) => classesFromExpr(e, acc));
      break;
    case 'CallExpression': node.arguments.forEach((a) => classesFromExpr(a, acc)); break; // clsx(...)
    case 'ConditionalExpression': classesFromExpr(node.consequent, acc); classesFromExpr(node.alternate, acc); break;
    case 'LogicalExpression': classesFromExpr(node.right, acc); break;
  }
}

function jsxToNode(node, classAcc) {
  // unwrap fragments: represent as a transparent node so its children matter
  if (node && node.type === 'JSXFragment') {
    const kids = (node.children || []).map((c) => jsxToNode(c, classAcc)).filter(Boolean);
    return kids.length === 1 ? kids[0] : { tag: '#fragment', classes: [], children: kids, text: '', attrs: {}, uid: '', idAttr: null };
  }
  if (!node || node.type !== 'JSXElement') return null;
  const name = node.openingElement.name;
  const tag = name.type === 'JSXIdentifier' ? name.name : 'Frag';
  const clsSet = new Set();
  for (const a of node.openingElement.attributes) {
    if (a.type === 'JSXAttribute' && (a.name.name === 'className' || a.name.name === 'class') && a.value) {
      if (a.value.type === 'StringLiteral') classesFromExpr(a.value, clsSet);
      else if (a.value.type === 'JSXExpressionContainer') classesFromExpr(a.value.expression, clsSet);
    }
  }
  const classes = [...clsSet];
  if (classAcc) classes.forEach((c) => classAcc.add(c));
  const children = [];
  for (const c of node.children || []) {
    if (c.type === 'JSXElement' || c.type === 'JSXFragment') { const n = jsxToNode(c, classAcc); if (n) children.push(n); }
  }
  return { tag, classes, children, text: '', attrs: {}, uid: '', idAttr: null };
}

function nodeSize(n) { return n ? 1 + (n.children || []).reduce((s, c) => s + nodeSize(c), 0) : 0; }

// read the class vocabulary from an imported CSS module file (authoritative)
async function moduleCssClasses(code, file) {
  const out = new Set();
  const { dirname, resolve: r } = await import('node:path');
  for (const m of code.matchAll(/import\s+\w+\s+from\s+['"]([^'"]+\.module\.(?:css|scss|sass|less))['"]/g)) {
    try {
      const css = await readFile(r(dirname(file), m[1]), 'utf8');
      for (const cm of css.matchAll(/\.([A-Za-z_][\w-]*)/g)) out.add(cm[1]);
    } catch { /* ignore missing */ }
  }
  return out;
}

async function analyzeJsx(code, file) {
  const out = { props: [], signature: null, tagSig: null, classes: [] };
  let ast;
  try {
    ast = babelParser.parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch { return out; }
  const propNames = new Set();
  const classAcc = new Set();
  const rootCandidates = []; // JSX that is a return value or arrow body

  traverse(ast, {
    TSInterfaceDeclaration(p) {
      if (/Props$/.test(p.node.id.name)) p.node.body.body.forEach((m) => m.key && m.key.name && propNames.add(m.key.name));
    },
    TSTypeAliasDeclaration(p) {
      if (/Props$/.test(p.node.id.name) && p.node.typeAnnotation.type === 'TSTypeLiteral') {
        p.node.typeAnnotation.members.forEach((m) => m.key && m.key.name && propNames.add(m.key.name));
      }
    },
    // component first-arg destructuring (covers fn decl, fn expr, AND arrows)
    Function(p) {
      const param = p.node.params[0];
      if (param && param.type === 'ObjectPattern') {
        param.properties.forEach((pr) => { if (pr.type === 'ObjectProperty' && pr.key.name) propNames.add(pr.key.name); });
      }
      // arrow with implicit JSX body:  const C = () => (<div/>)
      if (p.node.type === 'ArrowFunctionExpression' && p.node.body &&
          (p.node.body.type === 'JSXElement' || p.node.body.type === 'JSXFragment')) {
        rootCandidates.push(p.node.body);
      }
    },
    ReturnStatement(p) {
      const a = p.node.argument;
      if (a && (a.type === 'JSXElement' || a.type === 'JSXFragment')) rootCandidates.push(a);
    },
  });

  out.props = [...propNames];
  // pick the largest JSX root (skips `return null` guards, picks main render)
  let best = null, bestSize = 0;
  for (const cand of rootCandidates) {
    const n = jsxToNode(cand, classAcc);
    const sz = nodeSize(n);
    if (n && sz > bestSize) { best = n; bestSize = sz; }
  }
  if (best) { out.signature = structuralSignature(best); out.tagSig = tagSignature(best); }
  // class vocabulary: from JSX usage + authoritative module-css file
  const cssClasses = await moduleCssClasses(code, file);
  out.classes = [...new Set([...classAcc, ...cssClasses])];
  return out;
}

// ---- Vue SFC → signature + props (best effort) --------------------------
async function analyzeVue(code, file) {
  const out = { props: [], signature: null, tagSig: null, classes: [] };
  const classAcc = new Set();
  const tmpl = code.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
  if (tmpl) {
    try {
      const $ = cheerio.load(tmpl[1], null, false);
      const rootEl = $.root().children().toArray().find((e) => e.type === 'tag');
      if (rootEl) { const n = buildTree($, rootEl); out.signature = structuralSignature(n); out.tagSig = tagSignature(n); }
    } catch { /* ignore */ }
    // static class="..." and :class="styles.x" / styles['x']
    for (const m of tmpl[1].matchAll(/\bclass="([^"]*)"/g)) m[1].trim().split(/\s+/).filter(Boolean).forEach((c) => classAcc.add(c));
    for (const m of tmpl[1].matchAll(/:class="[^"]*?styles(?:\.(\w+)|\[['"]([\w-]+)['"]\])/g)) classAcc.add(m[1] || m[2]);
  }
  // defineProps({...}) | defineProps<{...}>() | withDefaults(defineProps<{...}>(), ...)
  const dpObj = code.match(/defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  const dpType = code.match(/defineProps\s*<\s*\{([\s\S]*?)\}\s*>/);
  const body = (dpObj && dpObj[1]) || (dpType && dpType[1]) || '';
  for (const m of body.matchAll(/(\w+)\s*[?:]/g)) out.props.push(m[1]);
  out.props = [...new Set(out.props)];
  const cssClasses = await moduleCssClasses(code, file);
  out.classes = [...new Set([...classAcc, ...cssClasses])];
  return out;
}

const files = await walkDir(root);
const components = [];
for (const file of files) {
  const code = await readFile(file, 'utf8');
  const framework = file.endsWith('.vue') ? 'vue' : 'react';
  const a = framework === 'vue' ? await analyzeVue(code, file) : await analyzeJsx(code, file);
  const name = pascalFromFile(file);
  components.push({
    name,
    path: relative(process.cwd(), file).replace(/\\/g, '/'),
    framework,
    props: a.props,
    structuralSignature: a.signature,
    tagSignature: a.tagSig,
    classes: a.classes,
    kind: LAYOUT_NAME.test(name) ? 'layout' : 'component',
    source: tag,
  });
}

await writeJSON(outPath, { root: relative(process.cwd(), root).replace(/\\/g, '/'), components });

console.log(JSON.stringify({
  ok: true, out: outPath, scanned: files.length,
  withSignature: components.filter((c) => c.structuralSignature).length,
  components: components.map((c) => ({ name: c.name, framework: c.framework, props: c.props.length, sig: !!c.structuralSignature })),
}, null, 2));
