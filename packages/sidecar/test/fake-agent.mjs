#!/usr/bin/env node
/**
 * A stand-in for `claude -p` that speaks just enough stream-json for the sidecar,
 * so the HTTP lifecycle can be exercised end to end without a network call or an
 * API key. Configure with env (inherited through the sidecar's child env):
 *
 *   FAKE_AGENT_EDIT   "path::find::replace" — edit one file, relative to cwd
 *   FAKE_AGENT_FAIL   "1" — exit non-zero with a readable error
 *   FAKE_AGENT_DELAY  milliseconds to wait before editing
 *
 * Usage as an agent: agent.command = "node", agent.args = ["<this file>"].
 * The sidecar appends the prompt as the final argument; it is ignored.
 */
import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  console.log('0.0.0 (fake agent)');
  process.exit(0);
}

const say = (text) =>
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));

await new Promise((r) => setTimeout(r, Number(process.env.FAKE_AGENT_DELAY ?? 0)));

if (process.env.FAKE_AGENT_FAIL === '1') {
  console.error('fake agent: could not find the element described in the comment');
  process.exit(2);
}

const [path, find, replace] = (process.env.FAKE_AGENT_EDIT ?? 'app.js::1::2').split('::');
say(`Looking at ${path}`);
const before = readFileSync(path, 'utf8');
if (!before.includes(find)) {
  console.error(`fake agent: "${find}" not found in ${path}`);
  process.exit(3);
}
writeFileSync(path, before.replace(find, replace));
say(`Edited ${path}`);
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: `Changed "${find}" to "${replace}" in ${path}` }));
