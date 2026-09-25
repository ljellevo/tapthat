/**
 * Builds tapthat.zip — the artifact attached to GitHub releases.
 *
 * Unzipping produces a single `tapthat/` folder that can be handed
 * straight to "Load unpacked", so nobody has to think about which directory to
 * select.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(root, '..', '..');
const staging = join(root, '.package');
const outDir = join(staging, 'tapthat');
const zipPath = join(root, 'tapthat.zip');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

// A release whose manifest version disagrees with the tag is confusing to
// debug later, so fail loudly rather than shipping the mismatch.
if (pkg.version !== manifest.version) {
  console.error(
    `version mismatch: package.json is ${pkg.version}, manifest.json is ${manifest.version}`,
  );
  process.exit(1);
}

if (!['content.js', 'background.js', 'options.js'].every((f) => existsSync(join(root, 'dist', f)))) {
  console.error('dist/ is missing — run `npm run build` first');
  process.exit(1);
}

rmSync(staging, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(outDir, { recursive: true });

// README.md is package-local (written for someone who just unzipped a folder);
// LICENSE lives at the repo root and is shared by every package. options.html
// must be listed: an options page missing from the zip is a silent 404 that
// only shows up after release.
for (const entry of ['manifest.json', 'dist', 'options.html', 'README.md']) {
  cpSync(join(root, entry), join(outDir, entry), { recursive: true });
}
cpSync(join(repoRoot, 'LICENSE'), join(outDir, 'LICENSE'));

execFileSync('zip', ['-r', '-q', zipPath, 'tapthat'], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

console.log(`packaged tapthat.zip (v${manifest.version})`);
