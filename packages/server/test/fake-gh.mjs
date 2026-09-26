#!/usr/bin/env node
/**
 * A stand-in for the GitHub CLI, for the installer's tests: `gh api` over a
 * JSON state file (FAKE_GH_STATE) of repositories → branches → files.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const out = (v) => process.stdout.write(JSON.stringify(v));
const notFound = () => {
  process.stderr.write('gh: Not Found (HTTP 404)\n');
  process.exit(1);
};
const fields = Object.fromEntries(
  args.flatMap((x, i) => (args[i - 1] === '-f' ? [[x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]] : [])),
);

state.log.push(args.filter((x, i) => !(args[i - 1] === '-f' && x.startsWith('content='))).join(' '));

if (args[0] === '--version') process.stdout.write('gh version 2.0.0\n');
else if (args[0] === 'auth') process.exit(0);
else if (args[0] === 'api') {
  const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
  const path = args.find((x, i) => i > 0 && !x.startsWith('-') && args[i - 1] !== '-X' && args[i - 1] !== '-f');
  const [pathname, query] = path.split('?');
  const ref = new URLSearchParams(query ?? '').get('ref');
  const m = /^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/.exec(pathname);
  const repo = m && state.repos[m[1]];
  if (!repo) notFound();
  const rest = m[2] ?? '';
  if (!rest) out({ default_branch: repo.default });
  else if (rest.startsWith('branches/')) {
    const b = decodeURIComponent(rest.slice('branches/'.length));
    if (!repo.branches[b]) notFound();
    out({ commit: { sha: `sha-${b}` } });
  } else if (rest === 'git/refs' && method === 'POST') {
    const b = fields.ref.replace('refs/heads/', '');
    const from = Object.keys(repo.branches).find((k) => `sha-${k}` === fields.sha);
    repo.branches[b] = JSON.parse(JSON.stringify(repo.branches[from]));
    out({ ref: fields.ref });
  } else if (rest.startsWith('contents/') && method === 'PUT') {
    const p = rest.slice('contents/'.length);
    const branch = repo.branches[fields.branch] ?? notFound();
    branch[p] = Buffer.from(fields.content, 'base64').toString('utf8');
    out({ commit: { message: fields.message } });
  } else if (rest.startsWith('contents/')) {
    const p = rest.slice('contents/'.length);
    const content = repo.branches[ref ?? repo.default]?.[p];
    if (content === undefined) notFound();
    out({ content: Buffer.from(content).toString('base64'), encoding: 'base64' });
  } else notFound();
} else {
  process.stderr.write(`fake gh: unsupported: ${args.join(' ')}\n`);
  process.exit(1);
}
save();
