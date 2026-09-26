/**
 * Guards the isStableClass heuristic. A false positive here (rejecting a real
 * class) degrades every selector on the page, so the camelCase cases matter as
 * much as the hash cases.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as esbuild from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const KEEP = [
  'btn', 'btn-primary', 'nav-link', 'card', 'site-header',
  'navLink', 'heroTitle', 'isActive', 'primaryButton', 'md', 'grid',
  'flex', 'items-center', 'gap-4', 'bg-blue-600', 'rounded-md',
  'Button', 'Header', 'ProductCard',
];

const REJECT = [
  'css-1a2b3c4', 'sc-bdVaJa', 'kXhFjL', 'Button_root__x7f3a',
  'jsx-1234567890', 'w-[calc(100%-2rem)]', 'md:gap-6', 'hover:bg-blue-700',
  'a1B2c3D4e5',
];

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only',
});

const bundle = await esbuild.build({
  entryPoints: [resolve(here, '../src/content/capture.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'AV',
  write: false,
  target: 'es2022',
});
dom.window.eval(bundle.outputFiles[0].text + '\n;window.AV = AV;');

// isStableClass isn't exported; exercise it through shortLabel on a real node.
const { document } = dom.window;
function keptClasses(cls) {
  const el = document.createElement('div');
  el.className = cls;
  document.body.appendChild(el);
  const label = dom.window.AV.shortLabel(el);
  el.remove();
  return label !== 'div';
}

let failed = 0;
for (const cls of KEEP) {
  if (!keptClasses(cls)) {
    console.log(`  ✗ rejected a legitimate class: "${cls}"`);
    failed++;
  }
}
for (const cls of REJECT) {
  if (keptClasses(cls)) {
    console.log(`  ✗ accepted a generated class: "${cls}"`);
    failed++;
  }
}

console.log(
  failed === 0
    ? `PASS — ${KEEP.length} stable classes kept, ${REJECT.length} generated classes rejected`
    : `FAIL — ${failed} classification error(s)`,
);
process.exit(failed === 0 ? 0 : 1);
