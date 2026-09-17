import type { CommentRecord } from './types';

/**
 * Mirrors HTML_CAP in the extension's capture.ts. Re-applied here because the
 * sidecar receives `html` over the wire from a client it cannot trust, so the
 * cap has to hold where the prompt is built, not only where it was captured.
 */
const HTML_CAP = 1200;

/**
 * Strips the parts of a captured element that are executable, invisible, or
 * both. A <script> body reaching the prompt is a prompt-injection vector on the
 * sidecar path and a slower-burning one on the clipboard path, so both variants
 * get this.
 */
export function sanitizeHtml(html: string): string {
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '<script>…</script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '<style>…</style>')
    // Comments are invisible to the reviewer but not to the agent — a natural
    // place to hide instructions.
    .replace(/<!--[\s\S]*?-->/g, '');

  return cleaned.length > HTML_CAP ? `${cleaned.slice(0, HTML_CAP)}…` : cleaned;
}

function openingTag(html: string): string {
  const end = html.indexOf('>');
  return end === -1 ? html.slice(0, 120) : html.slice(0, end + 1);
}

function formatStyles(styles: Record<string, string>): string {
  return Object.entries(styles)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

export function formatComment(c: CommentRecord): string {
  const html = sanitizeHtml(c.html);
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

  lines.push(`- **Element:** \`${openingTag(html)}\``);
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
  lines.push(html);
  lines.push('```');

  return lines.join('\n');
}
