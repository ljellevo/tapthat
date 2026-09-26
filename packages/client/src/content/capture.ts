import type { AncestorRef, CommentRecord } from '../types';

const TEXT_CAP = 200;
const HTML_CAP = 1200;

const INTERESTING_ATTRS = [
  'id',
  'class',
  'role',
  'aria-label',
  'aria-labelledby',
  'href',
  'src',
  'alt',
  'name',
  'type',
  'placeholder',
  'title',
  'value',
];

const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

const CAPTURED_STYLES = [
  'display',
  'position',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'font-family',
  'padding',
  'margin',
  'width',
  'height',
  'border-radius',
  'border',
  'gap',
  'flex-direction',
  'justify-content',
  'align-items',
  'grid-template-columns',
  'text-align',
  'opacity',
];

const LANDMARK_SELECTOR =
  'section, header, nav, main, footer, aside, article, form, dialog, [role]';

/**
 * Framework-generated class names (CSS modules, styled-components, Tailwind JIT
 * arbitrary values) change between builds, so a selector built on them breaks
 * immediately. Reject anything that looks generated.
 */
function isStableClass(cls: string): boolean {
  if (!cls || cls.length > 40) return false;
  // Hash-like suffix: Button_root__x7f3a, css-1a2b3c, sc-bdVaJa
  if (/[_-][a-z0-9]{5,}$/i.test(cls) && /\d/.test(cls)) return false;
  if (/^(css|sc)-[a-z0-9]{5,}$/i.test(cls)) return false;
  // Bare hash names like "kXhFjL" (emotion/styled-components) have no separator
  // and flip case almost every character — hand-written camelCase ("navLink")
  // flips once or twice, so the transition density separates them cleanly.
  if (!/[-_]/.test(cls) && /[a-z]/.test(cls) && /[A-Z]/.test(cls)) {
    // Digits interleaved with mixed case and no separator ("a1B2c3D4e5") is a
    // hash; real classes that mix case and digits use a separator ("bg-blue-600").
    if (cls.length >= 8 && /\d/.test(cls)) return false;

    let flips = 0;
    for (let i = 1; i < cls.length; i++) {
      const a = cls[i - 1];
      const b = cls[i];
      if (/[a-z]/.test(a) !== /[a-z]/.test(b) && /[a-zA-Z]/.test(a) && /[a-zA-Z]/.test(b)) flips++;
    }
    if (flips >= cls.length * 0.6) return false;
  }
  // Tailwind arbitrary values and responsive/state variants aren't valid bare
  // selectors without escaping — skip rather than fight the escaping rules.
  if (/[[\]().:/%#!]/.test(cls)) return false;
  return true;
}

function isStableId(id: string): boolean {
  if (!id || id.length > 50) return false;
  // React useId (":r0:"), radix ("radix-:r1:"), and digit-heavy generated ids.
  if (/[:[\]().]/.test(id)) return false;
  if (/^\d/.test(id)) return false;
  if (/\d{4,}/.test(id)) return false;
  return true;
}

function stableClasses(el: Element): string[] {
  return Array.from(el.classList).filter(isStableClass);
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
}

/** Candidate selectors for a single element, most specific/stable first. */
function levelCandidates(el: Element): string[] {
  const tag = el.tagName.toLowerCase();
  const out: string[] = [];

  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) out.push(`${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`);
  }

  const id = el.getAttribute('id');
  if (id && isStableId(id)) out.push(`#${cssEscape(id)}`);

  const classes = stableClasses(el);
  if (classes.length) {
    out.push(`${tag}.${classes.map(cssEscape).join('.')}`);
    if (classes.length > 1) out.push(`${tag}.${cssEscape(classes[0])}`);
  }

  const name = el.getAttribute('name');
  if (name) out.push(`${tag}[name="${name.replace(/"/g, '\\"')}"]`);

  out.push(tag);
  return out;
}

function indexOfType(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 1;
  return Array.from(parent.children).filter((c) => c.tagName === el.tagName).indexOf(el) + 1;
}

function nthOfType(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (sameTag.length === 1) return tag;
  return `${tag}:nth-of-type(${indexOfType(el)})`;
}

/**
 * The most descriptive selector for one element, qualified by position only
 * when its own siblings would otherwise be ambiguous.
 *
 * Descriptiveness matters as much as correctness here: `div.card:nth-of-type(3) >
 * button.btn-primary` tells an agent what to grep for, while a bare
 * `div:nth-of-type(3) > button` is both opaque and far more fragile.
 */
function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();

  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return `${tag}[${attr}="${v.replace(/"/g, '\\"')}"]`;
  }

  const id = el.getAttribute('id');
  if (id && isStableId(id)) return `#${cssEscape(id)}`;

  const classes = stableClasses(el);
  const base = classes.length ? `${tag}.${classes.map(cssEscape).join('.')}` : tag;

  const parent = el.parentElement;
  if (!parent) return base;

  try {
    if (parent.querySelectorAll(`:scope > ${base}`).length > 1) {
      return `${base}:nth-of-type(${indexOfType(el)})`;
    }
  } catch {
    return nthOfType(el);
  }
  return base;
}

/** Does the selector contain anything greppable — a class, id or attribute? */
function isNamed(selector: string): boolean {
  return /[.#[]/.test(selector);
}

function isUnique(selector: string): boolean {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/**
 * Shortest selector that resolves to exactly this element. Tries each candidate
 * on its own first, then progressively prepends ancestor context. Always
 * verified against the live document before being returned; falls back to a
 * full positional path if nothing else disambiguates.
 */
export function buildSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();

  // A globally unique attribute on the element itself beats any chain.
  for (const candidate of levelCandidates(el)) {
    if (candidate !== tag && isUnique(candidate)) return candidate;
  }

  // Otherwise grow a descriptive chain leftwards until it resolves to one node.
  let suffix = describe(el);
  if (isNamed(suffix) && isUnique(suffix)) return suffix;

  // A chain of bare tags (`div > div > span`) can be unique yet carries no
  // anchor an agent could grep for and breaks on any structural edit. Hold it
  // as a fallback and keep walking for a named ancestor to anchor to.
  let fallback: string | null = isUnique(suffix) ? suffix : null;

  let node: Element | null = el.parentElement;
  let depth = 0;
  while (node && node !== document.documentElement && depth < 10) {
    // A distinctive ancestor as a loose descendant prefix keeps the selector
    // short and readable: `section.pricing button.btn-primary`.
    for (const candidate of levelCandidates(node)) {
      if (candidate === node.tagName.toLowerCase()) continue;
      const combined = `${candidate} ${suffix}`;
      if (isUnique(combined)) return combined;
    }

    suffix = `${describe(node)} > ${suffix}`;
    if (isUnique(suffix)) {
      if (isNamed(suffix)) return suffix;
      fallback ??= suffix;
    }

    node = node.parentElement;
    depth++;
  }

  return fallback ?? fullPath(el);
}

function fullPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    parts.unshift(describe(node));
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** Human-readable chain, for the agent to read rather than to execute. */
export function buildDomPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    const id = node.getAttribute('id');
    if (id) part += `#${id}`;
    const classes = stableClasses(node).slice(0, 2);
    if (classes.length) part += `.${classes.join('.')}`;
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** Short label used in the hover chip, pin tooltips and the panel list. */
export function shortLabel(el: Element): string {
  const tag = el.tagName.toLowerCase();
  for (const attr of TEST_ID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return `${tag}[${v}]`;
  }
  const id = el.getAttribute('id');
  if (id) return `${tag}#${id}`;
  const classes = stableClasses(el).slice(0, 2);
  if (classes.length) return `${tag}.${classes.join('.')}`;
  return tag;
}

function collectAttributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of [...INTERESTING_ATTRS, ...TEST_ID_ATTRS]) {
    const v = el.getAttribute(attr);
    if (v) out[attr] = v.length > 160 ? `${v.slice(0, 160)}…` : v;
  }
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-') && !(attr.name in out)) {
      out[attr.name] = attr.value.length > 160 ? `${attr.value.slice(0, 160)}…` : attr.value;
    }
  }
  return out;
}

function collectAncestors(el: Element): AncestorRef[] {
  const out: AncestorRef[] = [];
  let node = el.parentElement;
  while (node && node !== document.documentElement && out.length < 4) {
    const ref: AncestorRef = { tag: node.tagName.toLowerCase() };
    const id = node.getAttribute('id');
    if (id) ref.id = id;
    const classes = stableClasses(node).slice(0, 3);
    if (classes.length) ref.classes = classes;
    out.push(ref);
    node = node.parentElement;
  }
  return out;
}

function describeLandmark(el: Element): string | null {
  const landmark = el.closest(LANDMARK_SELECTOR);
  if (!landmark || landmark === el) {
    const outer = el.parentElement?.closest(LANDMARK_SELECTOR);
    if (!outer) return null;
    return `<${outer.tagName.toLowerCase()}${attrHint(outer)}>`;
  }
  return `<${landmark.tagName.toLowerCase()}${attrHint(landmark)}>`;
}

function attrHint(el: Element): string {
  const id = el.getAttribute('id');
  if (id) return ` id="${id}"`;
  const classes = stableClasses(el).slice(0, 2);
  if (classes.length) return ` class="${classes.join(' ')}"`;
  const role = el.getAttribute('role');
  if (role) return ` role="${role}"`;
  return '';
}

/**
 * Nearest heading at or above the element in document order. This is usually the
 * single strongest hint for locating the right source file — headings are
 * literal strings the agent can grep for.
 */
function headingBefore(el: Element, root: ParentNode): string | null {
  const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  let best: Element | null = null;
  for (const h of headings) {
    if (h === el || h.contains(el)) continue;
    // el comes after h in document order
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h;
    else break;
  }
  const text = best?.textContent?.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, 120) : null;
}

/**
 * The heading is only reported when it belongs to the element's own landmark.
 * A heading borrowed from an unrelated earlier section is worse than none: it
 * reads as authoritative and sends the agent to the wrong part of the source.
 * When the landmark has no heading, the landmark itself is the locating signal.
 */
function findNearestHeading(el: Element): string | null {
  const scope = el.closest(LANDMARK_SELECTOR);
  return headingBefore(el, scope ?? document.body);
}

function truncateHtml(el: Element): string {
  const html = el.outerHTML;
  if (html.length <= HTML_CAP) return html;

  // Keep the opening tag intact (it carries the attributes the agent greps for)
  // and elide the middle rather than cutting mid-attribute.
  const openTagEnd = html.indexOf('>') + 1;
  const closeTag = `</${el.tagName.toLowerCase()}>`;
  const head = html.slice(0, Math.min(openTagEnd + HTML_CAP * 0.6, html.length));
  return `${head}\n  <!-- … ${html.length - HTML_CAP} more characters elided … -->\n${closeTag}`;
}

/** Values that carry no information — reporting them just burns agent attention. */
const NOOP_VALUES: Record<string, string[]> = {
  position: ['static'],
  opacity: ['1'],
  margin: ['0px', '0'],
  padding: ['0px', '0'],
  gap: ['0px', '0', 'normal'],
  'border-radius': ['0px', '0'],
  'text-align': ['start'],
  'font-weight': ['400'],
};

const FLEX_ONLY = ['flex-direction', 'justify-content', 'align-items', 'gap'];
const GRID_ONLY = ['grid-template-columns'];

function isTransparent(color: string): boolean {
  return color === 'transparent' || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(color);
}

function collectStyles(el: Element): Record<string, string> {
  const computed = getComputedStyle(el);
  const display = computed.getPropertyValue('display');
  const isFlex = display.includes('flex');
  const isGrid = display.includes('grid');

  const out: Record<string, string> = {};
  for (const prop of CAPTURED_STYLES) {
    // Layout properties are meaningless off their layout mode.
    if (FLEX_ONLY.includes(prop) && !isFlex && !isGrid) continue;
    if (GRID_ONLY.includes(prop) && !isGrid) continue;

    const v = computed.getPropertyValue(prop).trim();
    if (!v || v === 'none' || v === 'normal' || v === 'auto') continue;
    if (NOOP_VALUES[prop]?.includes(v)) continue;
    if (prop === 'background-color' && isTransparent(v)) continue;
    // "16px none rgb(0,0,0)" / "0px solid" — no visible border.
    if (prop === 'border' && (v.includes('none') || v.startsWith('0px'))) continue;

    out[prop] = v;
  }
  return out;
}

export function buildRecord(el: Element, comment: string, n: number): CommentRecord {
  const r = el.getBoundingClientRect();
  const parent = el.parentElement;
  const siblings = parent ? Array.from(parent.children) : [el];
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');

  return {
    id: crypto.randomUUID(),
    n,
    comment,
    createdAt: new Date().toISOString(),
    selector: buildSelector(el),
    domPath: buildDomPath(el),
    tagName: el.tagName.toLowerCase(),
    attributes: collectAttributes(el),
    text: text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text,
    html: truncateHtml(el),
    ancestors: collectAncestors(el),
    landmark: describeLandmark(el),
    nearestHeading: findNearestHeading(el),
    siblingIndex: siblings.indexOf(el) + 1,
    siblingCount: siblings.length,
    rect: {
      x: Math.round(r.left + scrollX),
      y: Math.round(r.top + scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height),
    },
    styles: collectStyles(el),
  };
}
