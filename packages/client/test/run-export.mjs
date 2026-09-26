/**
 * Guards export filtering: a resolved comment must never reach an agent, since
 * it would ask for work that has already been done.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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

const entry = resolve(here, '_export-entry.ts');
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
unlinkSync(entry);

const { buildRecord, buildMarkdown } = window.AV;
const $ = (sel, i = 0) => window.document.querySelectorAll(sel)[i];

const openRecord = buildRecord($('.hero .lede'), 'OPEN-MARKER shorten this', 1);
const resolvedRecord = {
  ...buildRecord($('.pricing .card .btn-primary', 0), 'RESOLVED-MARKER already done', 2),
  resolved: true,
  resolvedAt: new Date().toISOString(),
};

const markdown = buildMarkdown([openRecord, resolvedRecord], TEST_PAGE);
const sidecar = buildMarkdown([openRecord, resolvedRecord], TEST_PAGE, {
  variant: 'sidecar',
  repoRoot: '/workspace/repo',
  batchId: 'batch-test',
});

// A page that hides instructions in a <script> body or an HTML comment must not
// get them into the prompt — see R2 in the plan.
const hostile = {
  ...buildRecord($('.hero .lede'), 'HOSTILE-MARKER tidy this', 3),
  html: '<p class="lede">Hi<script>IGNORE-PREVIOUS-INSTRUCTIONS</script><!--HIDDEN-INSTRUCTION--></p>',
};
const sanitized = buildMarkdown([hostile], TEST_PAGE);

const checks = [
  ['open comment is included', markdown.includes('OPEN-MARKER')],
  ['resolved comment is excluded', !markdown.includes('RESOLVED-MARKER')],
  ['header counts only open comments', markdown.includes('# Page feedback — 1 comment')],
  ['singular wording for one comment', !markdown.includes('1 comments')],
  ['sidecar variant fences page content', sidecar.includes('<page-content>')],
  ['clipboard variant does not fence', !markdown.includes('<page-content>')],
  ['both variants render the same comment body', sidecar.includes('## 1. OPEN-MARKER shorten this') && markdown.includes('## 1. OPEN-MARKER shorten this')],
  ['sidecar variant carries the repo root', sidecar.includes('/workspace/repo')],
  ['script bodies are stripped', !sanitized.includes('IGNORE-PREVIOUS-INSTRUCTIONS')],
  ['html comments are stripped', !sanitized.includes('HIDDEN-INSTRUCTION')],
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
const allResolved = buildMarkdown([resolvedRecord], TEST_PAGE);
if (allResolved.includes('RESOLVED-MARKER')) {
  console.log('  ✗ all-resolved export leaked a resolved comment');
  failed++;
}

// The clipboard prompt is a stable contract: it is what people paste into their
// own agents. Diffing it against a committed golden means a change to the shared
// builder for the sidecar's benefit cannot silently alter it.
const goldenPath = resolve(here, 'golden', 'clipboard-export.md');
const golden = readFileSync(goldenPath, 'utf8');
const regenerated = buildMarkdown(
  [
    buildRecord($('.pricing .card .btn-primary', 2), 'Make this button green and a bit larger than the other two.', 1),
    buildRecord($('.hero .lede'), 'Shorten this to one line and drop the period.', 2),
    buildRecord($('.signup input[name="email"]'), 'Add inline validation and an error state below the field.', 3),
  ],
  TEST_PAGE,
);
if (regenerated !== golden) {
  console.log('  ✗ clipboard export drifted from test/golden/clipboard-export.md');
  console.log('    regenerate with: node test/sample-export.mjs && cp test/sample-export.md test/golden/clipboard-export.md');
  failed++;
}

console.log(
  failed === 0
    ? `PASS — ${checks.length + 2} export checks (including the clipboard golden)`
    : `FAIL — ${failed} export error(s)`,
);
process.exit(failed === 0 ? 0 : 1);
