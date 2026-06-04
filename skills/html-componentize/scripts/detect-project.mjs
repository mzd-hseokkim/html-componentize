#!/usr/bin/env node
// PHASE 0 (pre-interview) — Detect project. Infer config from the surrounding
// project so the interview only CONFIRMS + fills what can't be detected.
//
// Reads package.json deps, config files, and a bounded file scan for signals.
// Never guesses silently: anything ambiguous is reported under `ambiguities`
// for the interview to resolve.
//
// Usage:
//   node detect-project.mjs --root . --out .componentize/detected.json

import { resolve, relative } from 'node:path';
import { readFile, readdir, access } from 'node:fs/promises';
import { parseArgs, writeJSON } from './lib/domtree.mjs';

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root || '.');
const outPath = resolve(args.out || '.componentize/detected.json');

const exists = async (p) => { try { await access(resolve(root, p)); return true; } catch { return false; } };
const signals = [];
const note = (s) => signals.push(s);

// ---- package.json -------------------------------------------------------
let pkg = {};
try { pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')); } catch { note('no package.json'); }
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);

// ---- bounded file scan (existence of signal extensions) -----------------
const found = { vue: false, tsx: false, jsx: false, moduleCss: false, scopedStyle: false };
let scanned = 0;
async function scan(dir, depth = 0) {
  if (depth > 4 || scanned > 4000) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' || e.name === 'build') continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) { await scan(full, depth + 1); continue; }
    scanned++;
    if (e.name.endsWith('.vue')) {
      found.vue = true;
      try { if (/<style[^>]*\bscoped\b/.test(await readFile(full, 'utf8'))) found.scopedStyle = true; } catch {}
    } else if (e.name.endsWith('.tsx')) found.tsx = true;
    else if (e.name.endsWith('.jsx')) found.jsx = true;
    if (/\.module\.(css|scss|sass|less)$/.test(e.name)) found.moduleCss = true;
  }
}
await scan(root);

// ---- framework ----------------------------------------------------------
let framework = null, frameworkConfidence = 0;
const reactDep = has('react') || has('next') || has('@remix-run/react');
const vueDep = has('vue') || has('nuxt') || has('@vue/runtime-core');
if (reactDep && !vueDep) { framework = 'react'; frameworkConfidence = 0.95; note('react in deps'); }
else if (vueDep && !reactDep) { framework = 'vue'; frameworkConfidence = 0.95; note('vue in deps'); }
else if (reactDep && vueDep) { framework = null; note('BOTH react and vue in deps — ambiguous'); }
else if (found.vue && !(found.tsx || found.jsx)) { framework = 'vue'; frameworkConfidence = 0.7; note('.vue files, no jsx/tsx'); }
else if ((found.tsx || found.jsx) && !found.vue) { framework = 'react'; frameworkConfidence = 0.7; note('jsx/tsx files, no .vue'); }

// ---- language -----------------------------------------------------------
const tsconfig = await exists('tsconfig.json');
const lang = tsconfig || has('typescript') || found.tsx ? 'ts' : 'js';
note(`lang=${lang} (${tsconfig ? 'tsconfig' : has('typescript') ? 'typescript dep' : found.tsx ? '.tsx files' : 'default js'})`);

// ---- styling ------------------------------------------------------------
const stylingCandidates = [];
const tailwindCfg = (await exists('tailwind.config.js')) || (await exists('tailwind.config.ts'))
  || (await exists('tailwind.config.cjs')) || (await exists('tailwind.config.mjs'));
if (has('tailwindcss') || tailwindCfg) stylingCandidates.push('tailwind');
if (has('styled-components') || has('@emotion/react') || has('@emotion/styled')) stylingCandidates.push('css-in-js');
if (found.moduleCss) stylingCandidates.push('cssModules');
if (found.scopedStyle) stylingCandidates.push('scoped');
// primary: prefer an existing convention; default cssModules (preserves CSS)
const styling = stylingCandidates[0] || 'cssModules';
note(`styling candidates: ${stylingCandidates.join(', ') || 'none → default cssModules'}`);

// ---- roots --------------------------------------------------------------
const indexRoot = (await exists('src')) ? 'src' : '.';
let componentsDir = null;
for (const c of ['src/components', 'components', 'src/lib/components', 'app/components']) {
  if (await exists(c)) { componentsDir = c; break; }
}

// ---- scaffold boilerplate CSS (the silent layout-breaker) ---------------
// `npm create vite` / CRA ship index.css + App.css with opinionated defaults
// (button{padding:.6em 1.2em}, :root{}, body{place-items:center}, #root{...}).
// These OVERRIDE the UA defaults the source HTML relied on and break layout
// (e.g. icon buttons collapse). Detect so the skill can neutralize them.
const scaffoldStyles = [];
for (const p of ['src/index.css', 'src/App.css', 'index.css', 'App.css', 'src/main.css']) {
  if (!(await exists(p))) continue;
  let css = '';
  try { css = await readFile(resolve(root, p), 'utf8'); } catch { continue; }
  const sig = [];
  if (/button\s*\{[^}]*padding:\s*0?\.6em\s+1\.2em/s.test(css)) sig.push('vite button padding 0.6em 1.2em');
  if (/#root\s*\{/.test(css)) sig.push('#root rule');
  if (/place-items:\s*center/.test(css)) sig.push('body place-items:center');
  if (/:root\s*\{[^}]*(color-scheme|font-family)/s.test(css)) sig.push(':root defaults');
  if (/\.App-logo|\.read-the-docs|\.logo/.test(css)) sig.push('CRA/Vite template classes');
  if (sig.length) scaffoldStyles.push({ path: p, signals: sig });
}

// ---- package manager ----------------------------------------------------
let packageManager = 'npm';
if (await exists('pnpm-lock.yaml')) packageManager = 'pnpm';
else if (await exists('yarn.lock')) packageManager = 'yarn';
else if (await exists('bun.lockb')) packageManager = 'bun';

// ---- routing / layout convention ---------------------------------------
// Layout chrome (header/nav/footer) belongs in a shared layout + outlet, not
// duplicated per page. Detect the project's convention so codegen conforms.
let router = null, outlet = null;
const anyExists = async (...ps) => { for (const p of ps) if (await exists(p)) return p; return null; };
if (has('next')) {
  router = 'next';
  const appLayout = await anyExists('app/layout.tsx', 'app/layout.jsx', 'src/app/layout.tsx', 'src/app/layout.jsx');
  outlet = appLayout ? 'app-router: children prop in layout.tsx' : 'pages-router: _app.tsx wrapper';
} else if (has('@remix-run/react') || has('@remix-run/node')) { router = 'remix'; outlet = '<Outlet/>'; }
else if (has('@tanstack/react-router')) { router = 'tanstack-router'; outlet = '<Outlet/>'; }
else if (has('react-router-dom') || has('react-router')) { router = 'react-router'; outlet = '<Outlet/>'; }
else if (has('nuxt')) { router = 'nuxt'; outlet = 'layouts/ + <slot/> ; pages + <NuxtPage/>'; }
else if (has('vue-router')) { router = 'vue-router'; outlet = '<router-view/>'; }

// existing layout component / convention dir
const layoutPath = await anyExists(
  'app/layout.tsx', 'app/layout.jsx', 'src/app/layout.tsx', 'src/app/layout.jsx',
  'src/layouts', 'layouts', 'app.vue', 'src/App.vue',
  'src/components/Layout.tsx', 'src/components/Layout.jsx', 'src/components/Layout.vue',
  'src/layouts/default.vue', 'src/components/AppShell.tsx', 'src/components/AppLayout.tsx',
);
// NOTE: this is a fast-path HINT from known conventions only (fixed dep names +
// path list). It is NOT authoritative — the skill must verify/extend it (scan
// the workspace index for a kind:layout component, read the router config) when
// layoutPath is null or the project is non-standard. plan-files already falls
// back to the scanned index for layout discovery.
const routing = { library: router, outlet, hasLayout: !!layoutPath, layoutPath: layoutPath || null, basis: 'known-conventions' };
note(`routing: ${router || 'none detected'}${layoutPath ? `, layout at ${layoutPath}` : ', no layout found'}`);

// ---- ambiguities to resolve in the interview ----------------------------
const ambiguities = [];
if (router && !layoutPath) ambiguities.push(`layout: ${router} routing but no shared layout found — confirm strategy (hoist chrome into a new shared layout+outlet vs inline per page)`);
if (router && layoutPath) ambiguities.push(`layout: existing layout at ${layoutPath} — prefer reusing it (page = route content only), confirm`);
if (!router) ambiguities.push('layout: no router detected — treat as standalone page (inline chrome) unless told otherwise');
if (scaffoldStyles.length) ambiguities.push(`scaffold CSS: ${scaffoldStyles.map((s) => s.path).join(', ')} ship opinionated defaults (button padding, :root, #root, body) that OVERRIDE the source's UA defaults and break layout (collapsed icon buttons etc.) — NEUTRALIZE them (remove/override) before trusting the converted styles`);
if (!framework) ambiguities.push('framework: could not detect a single framework — ASK (react/vue)');
if (frameworkConfidence && frameworkConfidence < 0.9) ambiguities.push('framework: low-confidence guess — CONFIRM');
if (stylingCandidates.length > 1) ambiguities.push(`styling: multiple in use (${stylingCandidates.join(', ')}) — CONFIRM primary`);
if (stylingCandidates.includes('tailwind')) ambiguities.push('styling: project uses Tailwind — note this REWRITES authored CSS; confirm CSS-preserving alternative if fidelity matters');

const detected = {
  root: relative(process.cwd(), root).replace(/\\/g, '/') || '.',
  framework, frameworkConfidence,
  lang, styling, stylingCandidates,
  mode: (framework || componentsDir) ? 'integrate' : 'greenfield',
  indexRoot, componentsDir, packageManager,
  scaffoldStyles,
  routing,
  // default layout strategy: reuse existing layout if present, else hoist into a
  // shared layout+outlet when routing exists, else inline (standalone page)
  layoutStrategy: routing.hasLayout ? 'reuse-layout' : (router ? 'hoist' : 'inline'),
  signals,
};
await writeJSON(outPath, { detected, ambiguities });

console.log(JSON.stringify({ ok: true, out: outPath, detected, ambiguities }, null, 2));
