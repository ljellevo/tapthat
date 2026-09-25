#!/usr/bin/env node
/**
 * A stand-in for `claude -p` that speaks just enough stream-json for the sidecar,
 * so the HTTP lifecycle can be exercised end to end without a network call or an
 * API key. Configure with env (inherited through the sidecar's child env):
 *
 *   FAKE_AGENT_EDIT         "path::find::replace", or several joined with ";;" —
 *                           paths relative to cwd (the workspace root)
 *   FAKE_AGENT_FAIL         "1" — exit non-zero with a readable error, editing nothing
 *   FAKE_AGENT_FAIL_AFTER   "1" — make the edits, then fail (tests recovery)
 *   FAKE_AGENT_DELAY        milliseconds to wait before editing
 *   FAKE_AGENT_PROMPT_OUT   write the prompt it was given to this file
 *
 * Usage as an agent: agent.command = "node", agent.args = ["<this file>"].
 * The sidecar appends the prompt as the final argument; it is ignored.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

if (process.argv.includes('--version')) {
  console.log('0.0.0 (fake agent)');
  process.exit(0);
}

const say = (text) =>
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));

if (process.env.FAKE_AGENT_PROMPT_OUT) writeFileSync(process.env.FAKE_AGENT_PROMPT_OUT, process.argv.at(-1) ?? '');

await new Promise((r) => setTimeout(r, Number(process.env.FAKE_AGENT_DELAY ?? 0)));

if (process.env.FAKE_AGENT_FAIL === '1') {
  console.error('fake agent: could not find the element described in the comment');
  process.exit(2);
}

const edits = (process.env.FAKE_AGENT_EDIT ?? 'app.js::1::2').split(';;').map((e) => e.split('::'));
const done = [];
for (const [path, find, replace] of edits) {
  say(`Looking at ${path}`);
  let before = '';
  try {
    before = readFileSync(path, 'utf8');
  } catch {
    // An empty find means "create this file".
  }
  if (find && !before.includes(find)) {
    console.error(`fake agent: "${find}" not found in ${path}`);
    process.exit(3);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, find ? before.replace(find, replace) : replace);
  say(`Edited ${path}`);
  done.push(find ? `Changed "${find}" to "${replace}" in ${path}` : `Created ${path}`);
}
if (process.env.FAKE_AGENT_FAIL_AFTER === '1') {
  console.error('fake agent: gave up halfway through');
  process.exit(4);
}
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: done.join('; ') }));
