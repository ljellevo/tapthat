/**
 * Builds a full export document from the fixture page and prints it.
 * Use this to eyeball the exact payload an agent receives after changing
 * anything in capture.ts or the shared prompt builder.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { TEST_PAGE } from './page-context.mjs';
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

const entry = resolve(here, '_entry.ts');
writeFileSync(
  entry,
  `export { buildRecord } from '../src/content/capture';
export { buildMarkdown } from 'tapthat-shared';`,
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

const { buildRecord, buildMarkdown } = window.AV;
const $ = (sel, i = 0) => window.document.querySelectorAll(sel)[i];

const comments = [
  [$('.pricing .card .btn-primary', 2), 'Make this button green and a bit larger than the other two.'],
  [$('.hero .lede'), 'Shorten this to one line and drop the period.'],
  [$('.signup input[name="email"]'), 'Add inline validation and an error state below the field.'],
];

const records = comments.map(([el, text], i) => buildRecord(el, text, i + 1));
const markdown = buildMarkdown(records, TEST_PAGE);

writeFileSync(resolve(here, 'sample-export.md'), markdown);
console.log(markdown);

// Clean up the generated entry file.
const { unlinkSync } = await import('node:fs');
unlinkSync(entry);
