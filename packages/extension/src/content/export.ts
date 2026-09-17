import type { CommentRecord } from '../types';

const PREAMBLE = `Each item below is a change request attached to a specific element on the page above.
Use the selector, DOM path, nearest heading and HTML snippet to locate the matching source in
this repo — searching for the text content, class names, or data attributes is usually fastest —
then apply the requested change. If an element cannot be located with confidence, say so rather
than guessing at a different one.`;

function openingTag(html: string): string {
  const end = html.indexOf('>');
  return end === -1 ? html.slice(0, 120) : html.slice(0, end + 1);
}

function formatStyles(styles: Record<string, string>): string {
  return Object.entries(styles)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

function formatComment(c: CommentRecord): string {
  const lines: string[] = [];
  lines.push(`## ${c.n}. ${c.comment.split('\n')[0]}`);
  lines.push('');

  // Multi-line comments: keep the full text when the heading truncated it.
  if (c.comment.includes('\n')) {
    lines.push(c.comment);
    lines.push('');
  }

  if (c.stale) {
    lines.push(
      '> ⚠️ This element was not found on the page at export time — the captured context below is from when the comment was made and may be out of date.',
    );
    lines.push('');
  }

  lines.push(`- **Element:** \`${openingTag(c.html)}\``);
  lines.push(`- **Selector:** \`${c.selector}\``);
  lines.push(`- **DOM path:** \`${c.domPath}\``);
  if (c.text) lines.push(`- **Text:** "${c.text}"`);

  const place: string[] = [];
  if (c.landmark) place.push(`in \`${c.landmark}\``);
  if (c.nearestHeading) place.push(`nearest heading: "${c.nearestHeading}"`);
  if (place.length) lines.push(`- **Location:** ${place.join(' — ')}`);

  lines.push(
    `- **Position:** child ${c.siblingIndex} of ${c.siblingCount} · ${c.rect.w} × ${c.rect.h} at (${c.rect.x}, ${c.rect.y})`,
  );

  const styles = formatStyles(c.styles);
  if (styles) lines.push(`- **Key styles:** \`${styles}\``);

  lines.push('');
  lines.push('```html');
  lines.push(c.html);
  lines.push('```');

  return lines.join('\n');
}

export function buildMarkdown(comments: CommentRecord[]): string {
  // Resolved comments are done — sending them to an agent would ask for work
  // that has already happened. Filtered here too so no caller can leak them.
  const ordered = comments.filter((c) => !c.resolved).sort((a, b) => a.n - b.n);
  const plural = ordered.length === 1 ? 'comment' : 'comments';

  const head = [
    `# Page feedback — ${ordered.length} ${plural}`,
    '',
    `- **Page:** ${location.href}${document.title ? ` — "${document.title}"` : ''}`,
    `- **Captured:** ${new Date().toISOString()}`,
    `- **Viewport:** ${innerWidth} × ${innerHeight}`,
    '',
    PREAMBLE,
    '',
    '---',
    '',
  ].join('\n');

  return head + ordered.map(formatComment).join('\n\n---\n\n') + '\n';
}

/**
 * Clipboard write. Called from a real click inside our shadow DOM, so the
 * document is focused and the async API is permitted; the execCommand path
 * covers older/edge cases where it is not.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
