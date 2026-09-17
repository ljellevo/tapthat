/**
 * Guards export filtering: a resolved comment must never reach an agent, since
 * it would ask for work that has already been done.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, 'fixture.html'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost:3000/pricing',
});
const { window } = dom;
if (!window.crypto) window.crypto = {};
window.crypto.randomUUID ??= () => `id-${Math.random().toString(16).slice(2)}`;

const entry = resolve(here, '_export-entry.ts');
writeFileSync(
  entry,
  `export { buildRecord } from '../src/content/capture';
export { buildMarkdown } from '../src/content/export';`,
);

const bundle = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  globalName: 'AV',
  write: false,
  target: 'es2022',
});
window.eval(bundle.outputFiles[0].text + '\n;window.AV = AV;');
unlinkSync(entry);

const { buildRecord, buildMarkdown } = window.AV;
const $ = (sel, i = 0) => window.document.querySelectorAll(sel)[i];

const openRecord = buildRecord($('.hero .lede'), 'OPEN-MARKER shorten this', 1);
const resolvedRecord = {
  ...buildRecord($('.pricing .card .btn-primary', 0), 'RESOLVED-MARKER already done', 2),
  resolved: true,
  resolvedAt: new Date().toISOString(),
};

const markdown = buildMarkdown([openRecord, resolvedRecord]);

const checks = [
  ['open comment is included', markdown.includes('OPEN-MARKER')],
  ['resolved comment is excluded', !markdown.includes('RESOLVED-MARKER')],
  ['header counts only open comments', markdown.includes('# Page feedback — 1 comment')],
  ['singular wording for one comment', !markdown.includes('1 comments')],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

// A page whose comments are all resolved must produce an empty export, not a
// document with a dangling header.
const allResolved = buildMarkdown([resolvedRecord]);
if (allResolved.includes('RESOLVED-MARKER')) {
  console.log('  ✗ all-resolved export leaked a resolved comment');
  failed++;
}

console.log(
  failed === 0
    ? `PASS — ${checks.length + 1} export filtering checks`
    : `FAIL — ${failed} export filtering error(s)`,
);
process.exit(failed === 0 ? 0 : 1);
