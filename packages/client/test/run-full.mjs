/**
 * Light/Full mode in the real content script, under jsdom.
 *
 * The Light guarantee is the point: with default settings the extension must
 * make zero network requests and show no Apply button, byte-for-byte the tool it
 * was before Full existed. Then configuring a sidecar must bring Apply in live,
 * with no reload.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, 'fixture.html'), 'utf8');

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (!ok) { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
}

// ── bundle the pure pieces once ──────────────────────────────────────────────
const pureEntry = resolve(here, '_full-entry.ts');
writeFileSync(pureEntry, `export { modeFor } from '../src/content/mode';
export { normalizeOrigin, normalizeSidecarUrl, DEFAULTS } from '../src/settings';
export { track, applyEvent, applyStatus, phaseOf, commentPhases } from '../src/sidecar/tracked';`);
const pure = await esbuild.build({ entryPoints: [pureEntry], bundle: true, format: 'esm', write: false, platform: 'neutral' });
unlinkSync(pureEntry);
const pureMod = await import(`data:text/javascript;base64,${Buffer.from(pure.outputFiles[0].text).toString('base64')}`);
const { modeFor, normalizeOrigin, normalizeSidecarUrl, DEFAULTS, track, applyEvent, applyStatus, phaseOf, commentPhases } = pureMod;

// ── modeFor: derived, never stored ───────────────────────────────────────────
{
  const site = 'https://dev.example.com';
  check('default settings are Light', modeFor(DEFAULTS, site) === 'light');
  check('a sidecar alone does not make a site Full',
    modeFor({ ...DEFAULTS, sidecarUrl: 'http://localhost:7420' }, site) === 'light');
  check('an allowlisted site with a sidecar is Full',
    modeFor({ ...DEFAULTS, sidecarUrl: 'http://localhost:7420', allowedOrigins: [site] }, site) === 'full');
  check('any other site stays Light',
    modeFor({ ...DEFAULTS, sidecarUrl: 'http://localhost:7420', allowedOrigins: [site] }, 'https://bank.example') === 'light');
  check('sidecar URLs keep their /__tapthat path and lose a trailing slash',
    normalizeSidecarUrl(' https://x.up.railway.app/__tapthat/ ') === 'https://x.up.railway.app/__tapthat');
  check('non-http sidecar URLs are rejected', normalizeSidecarUrl('javascript:alert(1)') === null);
  check('a pasted page URL becomes its origin', normalizeOrigin('https://x.dev/a/b?c') === 'https://x.dev');
}

// ── tracked batch reducer ────────────────────────────────────────────────────
{
  const ev = (seq, type, extra = {}) => ({ seq, batchId: 'b', at: '', type, ...extra });
  let b = track({ batchId: 'b', state: 'queued', queueDepth: 1, baseSha: 'aaa', branch: 'dev', eventsToken: 't' }, ['c1', 'c2']);
  check('a new batch is queued', phaseOf(b) === 'queued' && b.ahead === 1);
  b = applyEvent(b, ev(0, 'started'));
  check('started → editing', phaseOf(b) === 'editing');
  b = applyEvent(b, ev(1, 'agent-message', { message: 'Looking at Hero.tsx\nmore' }));
  check('agent chatter becomes one line of progress', b.progress === 'Looking at Hero.tsx');
  b = applyEvent(b, ev(2, 'files-changed', { files: ['src/Hero.tsx'] }));
  check('files on disk while still running → live (HMR has fired)', phaseOf(b) === 'live');
  const replay = applyEvent(b, ev(1, 'agent-message', { message: 'stale' }));
  check('replayed events are ignored by seq', replay === b);
  b = applyEvent(b, ev(3, 'committed', { sha: 'bbbbbbb' }));
  check('committed carries the sha', phaseOf(b) === 'committed' && b.sha === 'bbbbbbb');
  const unverified = applyStatus(b, {
    state: 'applied-unverified', events: [ev(4, 'verify-failed', { output: 'TS2322: nope' })],
    result: { summary: 's', filesChanged: ['src/Hero.tsx'], durationMs: 1 }, error: { kind: 'agent', message: 'TS2322: nope' },
  });
  check('a broken build is its own phase, with the compiler output',
    phaseOf(unverified) === 'unverified' && unverified.verifyOutput === 'TS2322: nope');
  const phases = commentPhases([b, { ...track({ batchId: 'x', state: 'queued', queueDepth: 0, baseSha: null, branch: 'dev', eventsToken: null }, ['c2']) }]);
  check('the newest batch wins per comment', phases.get('c1') === 'committed' && phases.get('c2') === 'queued');
}

// ── the content script under jsdom ───────────────────────────────────────────
const entry = resolve(here, '_content-entry.ts');
writeFileSync(entry, `import '../src/content/index';`);
const bundle = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', write: false, target: 'es2022' });
unlinkSync(entry);

function makeChrome() {
  const data = {};
  const changeListeners = new Set();
  const messageListeners = new Set();
  const chrome = {
    storage: {
      local: {
        async get(key) { return typeof key === 'string' ? (key in data ? { [key]: structuredClone(data[key]) } : {}) : { ...data }; },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: data[k], newValue: structuredClone(v) }; data[k] = structuredClone(v); }
          for (const fn of changeListeners) fn(changes, 'local');
        },
        async remove(key) { delete data[key]; },
      },
      onChanged: { addListener: (fn) => changeListeners.add(fn), removeListener: (fn) => changeListeners.delete(fn) },
    },
    _sent: [],
    runtime: {
      sendMessage: async (msg) => { chrome._sent.push(msg); },
      onMessage: { addListener: (fn) => messageListeners.add(fn) },
      getManifest: () => ({ version: '0.0.0-test' }),
    },
    _send: (msg) => { for (const fn of messageListeners) fn(msg); },
  };
  return chrome;
}

const HEALTH = {
  status: 'ok', version: 't', repo: { branch: 'dev', head: 'abc1234', clean: true },
  repos: [{ name: 'app', branch: 'dev', head: 'abc1234', clean: true }],
  devServer: { reachable: true, url: 'http://localhost:5173' }, devServers: [],
  queue: { depth: 0, running: false }, agent: { cliVersion: '1', envCredential: true }, killSwitch: false,
  mode: 'commit', session: null,
};

/** `respond(path, method, body)` scripts the sidecar; the default is a healthy one in commit mode. */
async function boot(url, respond = () => HEALTH) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url });
  const { window } = dom;
  const requests = [];
  window.chrome = makeChrome();
  window.fetch = async (input, init = {}) => {
    requests.push(String(input));
    const path = new URL(String(input)).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const answer = respond(path, init.method ?? 'GET', body);
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  window.EventSource = class { constructor(u) { requests.push(`EventSource ${u}`); } close() {} };
  window.crypto.randomUUID ??= () => `id-${Math.random().toString(16).slice(2)}`;
  // Closed shadow roots are the right call in production; the test needs to look inside.
  const attach = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) { return attach.call(this, { ...init, mode: 'open' }); };
  window.eval(bundle.outputFiles[0].text);
  await new Promise((r) => setTimeout(r, 50));
  const root = () => window.document.querySelector('tapthat-root')?.shadowRoot;
  const button = (label) => [...(root()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
  return { window, requests, root, button };
}

// Light: a fresh profile on a local dev host — the launcher is there, the network is not.
{
  const { window, requests, button, root } = await boot('http://localhost:3000/pricing');
  window.chrome._send({ type: 'TOGGLE' });
  await new Promise((r) => setTimeout(r, 50));
  check('Light: the panel mounts with Export', !!button('Export'));
  check('Light: Export is the primary button', button('Export')?.classList.contains('primary'));
  check('Light: Send to Claude is hidden', button('Send to Claude')?.hidden === true);
  const help = root()?.querySelector('.panel-help');
  check('Light: the help button is in the panel header', !!help && help.textContent === '?');
  help?.click();
  check('help asks the background to open the help page',
    window.chrome._sent.some((m) => m.type === 'OPEN_HELP'), JSON.stringify(window.chrome._sent));
  const settingsBtn = root()?.querySelector('.panel-settings');
  check('Light: the settings button is in the panel header', !!settingsBtn);
  settingsBtn?.click();
  check('settings asks the background to open the options page',
    window.chrome._sent.some((m) => m.type === 'OPEN_OPTIONS'), JSON.stringify(window.chrome._sent));
  check('Light: zero network requests', requests.length === 0, requests.join(', '));
  window.close();
}

// ── The help page: static, and every link into it lands somewhere ────────────
{
  const help = readFileSync(resolve(here, '..', 'help.html'), 'utf8');
  const ids = new Set([...help.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  check('help.html runs no script (static, works offline)', !/<script/i.test(help));
  const internal = [...help.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const missing = internal.filter((id) => !ids.has(id));
  check('every in-page help link has a target', missing.length === 0, missing.join(', '));
  const options = readFileSync(resolve(here, '..', 'options.html'), 'utf8');
  const fromOptions = [...options.matchAll(/href="help\.html#([^"]+)"/g)].map((m) => m[1]);
  const code = ['key'];  // full.ts opens help.html#key from the connect sheet
  const dangling = [...fromOptions, ...code].filter((id) => !ids.has(id));
  check('links from the options page and the connect sheet land on real sections',
    fromOptions.length > 0 && dangling.length === 0, dangling.join(', '));
  check('the zip includes help.html',
    readFileSync(resolve(here, '..', 'package.mjs'), 'utf8').includes("'help.html'"));
}

// Full: configuring a sidecar for this origin brings Apply in without a reload.
{
  const { window, requests, button, root } = await boot('http://localhost:3000/pricing');
  window.chrome._send({ type: 'TOGGLE' });
  await new Promise((r) => setTimeout(r, 50));
  await window.chrome.storage.local.set({
    'av:settings': { sidecarUrl: 'http://localhost:7420', token: 't', credential: null, allowedOrigins: ['http://localhost:3000'] },
  });
  await new Promise((r) => setTimeout(r, 100));
  check('Full: Send to Claude appears live', button('Send to Claude')?.hidden === false);
  check('Full: Apply becomes primary', button('Send to Claude')?.classList.contains('primary'));
  check('Full: Export is hidden while the sidecar is healthy', button('Export')?.hidden === true);
  check('Full: the sidecar is asked for health', requests.some((r) => r.endsWith('/healthz')), requests.join(', '));
  const status = root()?.querySelector('.panel-status');
  check('Full: no repo or commit line while all is well', status?.hidden === true, status?.textContent);
  check('Full: Send to Claude sits right under the comments',
    button('Send to Claude')?.parentElement === root()?.querySelector('.panel-list')?.nextElementSibling);

  await window.chrome.storage.local.set({ 'av:settings': { ...DEFAULTS } });
  await new Promise((r) => setTimeout(r, 50));
  check('clearing settings goes back to Light live', button('Send to Claude')?.hidden === true
    && button('Export')?.classList.contains('primary') && button('Export')?.hidden === false);
  window.close();
}

// Full with the sidecar paused: Export comes back, as the status line promises.
{
  const { window, button } = await boot('http://localhost:3000/pricing', () => ({ ...HEALTH, killSwitch: true }));
  window.chrome._send({ type: 'TOGGLE' });
  await new Promise((r) => setTimeout(r, 50));
  await window.chrome.storage.local.set({
    'av:settings': { sidecarUrl: 'http://localhost:7420', token: 't', credential: null, allowedOrigins: ['http://localhost:3000'] },
  });
  await new Promise((r) => setTimeout(r, 100));
  check('Full, paused: Export is back as a ghost fallback',
    button('Export')?.hidden === false && button('Export')?.classList.contains('ghost'));
  window.close();
}

// Full settings for a different site leave this one Light and silent.
{
  const { window, requests, button } = await boot('http://localhost:3000/pricing');
  await window.chrome.storage.local.set({
    'av:settings': { sidecarUrl: 'http://localhost:7420', token: 't', credential: null, allowedOrigins: ['https://elsewhere.dev'] },
  });
  window.chrome._send({ type: 'TOGGLE' });
  await new Promise((r) => setTimeout(r, 100));
  check('off-allowlist: Apply stays hidden', button('Send to Claude')?.hidden === true);
  check('off-allowlist: still zero network requests', requests.length === 0, requests.join(', '));
  window.close();
}

// ── A playground (git.mode "session") ────────────────────────────────────────
{
  const sidecar = { session: null, calls: [] };
  const pending = [{ batchId: 'b1', at: new Date().toISOString(), summary: 'Added stage', files: ['api/src/x.ts'],
    comments: ['Show the deal stage'], pageUrl: 'http://localhost:3000/pricing', reviewer: 'Ana' }];
  const respond = (path, method, body) => {
    if (method === 'POST') sidecar.calls.push(`${method} ${path} ${JSON.stringify(body ?? {})}`);
    if (path === '/healthz') return { ...HEALTH, mode: 'session', session: sidecar.session && { id: 's1', state: sidecar.session.state, pending: 1 } };
    if (path === '/api/session/start') {
      sidecar.session = { id: 's1', state: 'active', startedAt: 'x', startedBy: 'Ana', branch: 'tapthat/session-s1', base: [], pending, events: [],
        repos: [{ name: 'app', files: ['src/p.tsx'] }, { name: 'api', files: ['src/x.ts', 'src/y.ts'] }], error: null };
    }
    if (path === '/api/session/commit') {
      sidecar.session = null;
      return { id: 's1', outcome: 'committed', at: new Date().toISOString(), by: 'Ana', commits: [{ repo: 'api', sha: 'a1b2c3d' }, { repo: 'app', sha: 'd4e5f6a' }], notices: ['api/shared/contracts changed. admin keep their own copy: sync it there too.'] };
    }
    if (path.startsWith('/api/session')) {
      return { mode: 'session', session: sidecar.session, last: sidecar.session ? null
        : { id: 's1', outcome: 'committed', at: new Date().toISOString(), by: 'Ana', commits: [{ repo: 'api', sha: 'a1b2c3d' }, { repo: 'app', sha: 'd4e5f6a' }], notices: ['api/shared/contracts changed. admin keep their own copy: sync it there too.'] } };
    }
    return HEALTH;
  };
  const { window, button, root } = await boot('http://localhost:3000/pricing', respond);
  await window.chrome.storage.local.set({
    'av:settings': { sidecarUrl: 'http://localhost:7420', token: 't', credential: null, allowedOrigins: ['http://localhost:3000'], reviewerName: 'Ana' },
  });
  window.chrome._send({ type: 'TOGGLE' });
  const settle = () => new Promise((r) => setTimeout(r, 150));
  await settle();
  const strip = () => root()?.querySelector('.session');
  check('playground: with no session, the strip offers Start session', !!button('Start session') && strip()?.hidden === false);
  check('playground: Apply waits for a session', button('Send to Claude')?.hidden === true);
  const foot = () => root()?.querySelector('.panel-foot');
  check('playground: Start session is in the footer', button('Start session')?.parentElement === foot());

  button('Start session').click();
  await settle();
  check('Start session posts with the reviewer\'s name',
    sidecar.calls.some((c) => c.startsWith('POST /api/session/start') && c.includes('"reviewer":"Ana"')), sidecar.calls.join(' | '));
  check('an active session lists its pending changes',
    strip()?.textContent.includes('1 change ready for dev') && strip()?.textContent.includes('Show the deal stage — Ana'), strip()?.textContent);
  check('it does not list repos or files', !strip()?.textContent.includes('app, api') && !strip()?.textContent.includes('3 files'), strip()?.textContent);
  check('Apply is available during a session', button('Send to Claude')?.hidden === false);

  check('Cancel session and Save session changes are in the footer',
    button('Cancel session')?.parentElement === foot() && button('Save session changes')?.parentElement === foot());
  check('Save session changes is styled apart from Send to Claude', button('Save session changes')?.classList.contains('commit')
    && !button('Send to Claude')?.classList.contains('commit'));
  button('Save session changes').click();
  await settle();
  check('Save session changes asks for a second click first',
    !!button('Save 1 change to dev?') && !sidecar.calls.some((c) => c.includes('/api/session/commit')));
  button('Save 1 change to dev?').click();
  await settle();
  check('the second click sends it', sidecar.calls.some((c) => c.startsWith('POST /api/session/commit')));
  check('after saving the strip says it reached dev, without repos or commits',
    strip()?.textContent.includes('Saved to dev') && !strip()?.textContent.includes('a1b2c3d'), strip()?.textContent);
  check('…and relays notices for a human', strip()?.textContent.includes('sync it there too'));
  check('…and offers the next Start session', !!button('Start session'));
  window.close();
}

console.log(failed === 0 ? `PASS — ${total} Light/Full mode checks` : `FAIL — ${failed} of ${total} Light/Full mode checks`);
process.exit(failed === 0 ? 0 : 1);
