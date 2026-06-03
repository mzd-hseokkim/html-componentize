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
function jsxToNode(node) {
  if (!node || node.type !== 'JSXElement') return null;
  const name = node.openingElement.name;
  const tag = name.type === 'JSXIdentifier' ? name.name : 'Frag';
  let classes = [];
  for (const a of node.openingElement.attributes) {
    if (a.type === 'JSXAttribute' && (a.name.name === 'className' || a.name.name === 'class')) {
      if (a.value && a.value.type === 'StringLiteral') classes = a.value.value.trim().split(/\s+/).filter(Boolean);
    }
  }
  const children = [];
  for (const c of node.children || []) {
    if (c.type === 'JSXElement') { const n = jsxToNode(c); if (n) children.push(n); }
  }
  return { tag, classes, children, text: '', attrs: {}, uid: '', idAttr: null };
}

function analyzeJsx(code, file) {
  const out = { props: [], signature: null, tagSig: null };
  let ast;
  try {
    ast = babelParser.parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch { return out; }
  const propNames = new Set();
  let rootJsx = null;
  traverse(ast, {
    TSInterfaceDeclaration(p) {
      if (/Props$/.test(p.node.id.name)) p.node.body.body.forEach((m) => m.key && m.key.name && propNames.add(m.key.name));
    },
    TSTypeAliasDeclaration(p) {
      if (/Props$/.test(p.node.id.name) && p.node.typeAnnotation.type === 'TSTypeLiteral') {
        p.node.typeAnnotation.members.forEach((m) => m.key && m.key.name && propNames.add(m.key.name));
      }
    },
    // function component first-arg destructuring: function C({ a, b }) {}
    Function(p) {
      const param = p.node.params[0];
      if (param && param.type === 'ObjectPattern') {
        param.properties.forEach((pr) => { if (pr.type === 'ObjectProperty' && pr.key.name) propNames.add(pr.key.name); });
      }
    },
    ReturnStatement(p) {
      if (!rootJsx && p.node.argument && p.node.argument.type === 'JSXElement') rootJsx = p.node.argument;
    },
  });
  out.props = [...propNames];
  if (rootJsx) { const n = jsxToNode(rootJsx); if (n) { out.signature = structuralSignature(n); out.tagSig = tagSignature(n); } }
  return out;
}

// ---- Vue SFC → signature + props (best effort) --------------------------
function analyzeVue(code) {
  const out = { props: [], signature: null, tagSig: null };
  const tmpl = code.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
  if (tmpl) {
    try {
      const $ = cheerio.load(tmpl[1], null, false);
      const rootEl = $.root().children().toArray().find((e) => e.type === 'tag');
      if (rootEl) { const n = buildTree($, rootEl); out.signature = structuralSignature(n); out.tagSig = tagSignature(n); }
    } catch { /* ignore */ }
  }
  // defineProps({...}) keys  OR  defineProps<{...}>()
  const dpObj = code.match(/defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/);
  const dpType = code.match(/defineProps\s*<\s*\{([\s\S]*?)\}\s*>/);
  const body = (dpObj && dpObj[1]) || (dpType && dpType[1]) || '';
  for (const m of body.matchAll(/(\w+)\s*[?:]/g)) out.props.push(m[1]);
  out.props = [...new Set(out.props)];
  return out;
}

const files = await walkDir(root);
const components = [];
for (const file of files) {
  const code = await readFile(file, 'utf8');
  const framework = file.endsWith('.vue') ? 'vue' : 'react';
  const a = framework === 'vue' ? analyzeVue(code) : analyzeJsx(code, file);
  const name = pascalFromFile(file);
  components.push({
    name,
    path: relative(process.cwd(), file).replace(/\\/g, '/'),
    framework,
    props: a.props,
    structuralSignature: a.signature,
    tagSignature: a.tagSig,
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
