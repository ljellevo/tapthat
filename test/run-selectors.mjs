/**
 * Runs the selector harness against the fixture under jsdom.
 * Verifies that every element in the fixture gets a selector that is valid,
 * unique, and resolves back to the element it was built from.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

const html = readFileSync(resolve(here, 'fixture.html'), 'utf8').replace(
  '<script src="./harness.js"></script>',
  '',
);

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// jsdom lacks a few browser globals the capture code touches.
if (!window.crypto) window.crypto = {};
if (!window.crypto.randomUUID) {
  window.crypto.randomUUID = () => `id-${Math.random().toString(16).slice(2)}`;
}

const bundle = await esbuild.build({
  entryPoints: [resolve(here, 'harness.ts')],
  bundle: true,
  format: 'iife',
  write: false,
  target: 'es2022',
  globalName: '__av',
});

window.eval(bundle.outputFiles[0].text);

const result = window.__avResult;
const { checked, failures } = result;

console.log(`checked ${checked} elements`);
if (failures.length === 0) {
  console.log('PASS — every selector is unique and round-trips to its element');
} else {
  console.log(`FAIL — ${failures.length} bad selector(s):`);
  for (const f of failures) {
    console.log(`  ✗ ${f.label} -> ${f.selector}  (${f.reason}, ${f.matches} matches)`);
  }
}

console.log('\n--- sample record (3rd of three identical "Choose" buttons) ---');
const s = result.sample;
console.log(
  JSON.stringify(
    {
      selector: s.selector,
      domPath: s.domPath,
      text: s.text,
      landmark: s.landmark,
      nearestHeading: s.nearestHeading,
      siblingIndex: s.siblingIndex,
      siblingCount: s.siblingCount,
      attributes: s.attributes,
    },
    null,
    2,
  ),
);

process.exit(failures.length === 0 ? 0 : 1);
