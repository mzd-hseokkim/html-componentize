#!/usr/bin/env node
// PHASE 5 — Verify fidelity. Render BOTH, pixel-diff + DOM-diff, pass/fail gate.
//
// This is the loop nobody else closes: we render the original AND the built
// component and PROVE they match — not vibe-check. computed style is used ONLY
// here (as an oracle), never to generate code.
//
// The --result URL must be a running dev server rendering the converted
// component in isolation (the skill spins this up). --original is the source
// HTML file (or a URL).
//
// Usage:
//   node verify-fidelity.mjs --original page.html --result http://localhost:5173 \
//        --viewports 1280x800,375x667 --threshold 0.01 --out .componentize/verify
//
// Exit code 0 = pass (all viewports within threshold), 1 = fail.

import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { parseArgs } from './lib/domtree.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.original || !args.result) {
  console.error('error: --original <file|url> and --result <url> required');
  process.exit(2);
}
const toUrl = (s) => /^https?:|^file:/.test(s) ? s : pathToFileURL(isAbsolute(s) ? s : resolve(s)).href;
const originalUrl = toUrl(args.original);
const resultUrl = toUrl(args.result);
const outDir = resolve(args.out || '.componentize/verify');
const threshold = Number(args.threshold ?? 0.01);          // max fraction of differing pixels
const pxThreshold = Number(args.pxThreshold ?? 0.1);        // per-pixel color sensitivity
const viewports = String(args.viewports || '1280x800,375x667')
  .split(',').map((v) => { const [w, h] = v.split('x').map(Number); return { w, h }; });

await mkdir(outDir, { recursive: true });

const domSigScript = `(() => {
  const sig = (el) => {
    const cls = (el.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).sort().join('.');
    const kids = [...el.children].map(sig).join(',');
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (kids ? '(' + kids + ')' : '');
  };
  return sig(document.body);
})()`;

const browser = await chromium.launch();
const results = [];
try {
  for (const vp of viewports) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });

    await page.goto(originalUrl, { waitUntil: 'networkidle' });
    const origShot = await page.screenshot({ fullPage: false });
    const origDom = await page.evaluate(domSigScript);
    const origHeight = await page.evaluate('document.body.scrollHeight');

    await page.goto(resultUrl, { waitUntil: 'networkidle' });
    const resShot = await page.screenshot({ fullPage: false });
    const resDom = await page.evaluate(domSigScript);
    const resHeight = await page.evaluate('document.body.scrollHeight');
    await page.close();

    const a = PNG.sync.read(origShot);
    const b = PNG.sync.read(resShot);
    const width = Math.min(a.width, b.width);
    const height = Math.min(a.height, b.height);
    const diff = new PNG({ width, height });
    // crop both to common size into fresh buffers
    const crop = (img) => {
      const out = new PNG({ width, height });
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const si = (img.width * y + x) << 2;
          const di = (width * y + x) << 2;
          out.data[di] = img.data[si]; out.data[di + 1] = img.data[si + 1];
          out.data[di + 2] = img.data[si + 2]; out.data[di + 3] = img.data[si + 3];
        }
      }
      return out;
    };
    const ca = crop(a), cb = crop(b);
    const mismatch = pixelmatch(ca.data, cb.data, diff.data, width, height, { threshold: pxThreshold });
    const ratio = mismatch / (width * height);

    const tag = `${vp.w}x${vp.h}`;
    await writeFile(`${outDir}/diff-${tag}.png`, PNG.sync.write(diff));
    await writeFile(`${outDir}/original-${tag}.png`, origShot);
    await writeFile(`${outDir}/result-${tag}.png`, resShot);

    results.push({
      viewport: tag,
      diffPixels: mismatch,
      diffRatio: Number(ratio.toFixed(5)),
      pass: ratio <= threshold,
      domMatch: origDom === resDom,
      scrollHeight: { original: origHeight, result: resHeight, delta: resHeight - origHeight },
      artifacts: { diff: `diff-${tag}.png`, original: `original-${tag}.png`, result: `result-${tag}.png` },
    });
  }
} finally {
  await browser.close();
}

const pass = results.every((r) => r.pass);
const report = { originalUrl, resultUrl, threshold, pass, viewports: results, outDir };
await writeFile(`${outDir}/verify-report.json`, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
process.exit(pass ? 0 : 1);
